import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRightIcon } from '@heroicons/react/24/outline';
import { t } from '../../i18n';
import { getMobileElectron } from '../appBridge';
import { useIdentity } from '../hooks/useIdentity';
import { useSettings } from '../hooks/useSettings';
import { useMemorySettings } from '../hooks/useMemorySettings';
import { useSkills } from '../hooks/useSkills';
import { useMetabots } from '../hooks/useMetabots';
import { BotAvatar } from '../components/BotAvatar';
import { BottomSheet } from '../components/BottomSheet';
import { MeBalanceChip } from '../components/MeBalanceChip';
import { MePointsHero } from '../components/MePointsHero';
import { MeTierCards } from '../components/MeTierCards';
import {
  ensureMeOverview,
  isMeSubscribed,
  meActivePlanId,
  meActiveTierKey,
  meSubscriptionExpiryMs,
  meCurrentPlan,
  meFromMilli,
  refreshMeBalance,
  refreshMeCatalog,
  refreshMeSubscription,
  useMeStore,
} from '../me/mePointsStore';
import {
  ME_ENTRY_GROUPS,
  meEntriesForGroup,
  type MeEntrySummaryInput,
  type MeRoute,
} from './me/registry';
import { ProfilePage } from './me/ProfilePage';
import { UsageCreditsPage } from './me/UsageCreditsPage';
import { BotsPage } from './me/BotsPage';
import { BotEditPage } from './me/BotEditPage';
import { SkillsPage } from './me/SkillsPage';
import { MemoryPage } from './me/MemoryPage';
import { GeneralPage } from './me/GeneralPage';
import { AccountPage } from './me/AccountPage';
import { WeixinBindPage } from './me/WeixinBindPage';
import { AboutPage } from './me/AboutPage';

/**
 * Me tab (REQ-E-14), A6 settings IA rework (IA-PLAN v1) + S9 ME points home.
 *
 * The primary page is now the points home: a merged ME balance hero with the
 * four-bucket ledger, the current plan / weekly progress line, the three-tier
 * sales cards and the upgrade/renew path — followed by the registry-rendered
 * settings rows. The old traffic page is gone; `usage` is the merged
 * Usage & credits page (S9 §3).
 *
 * Navigation: every entry pushes a secondary page on a local stack riding on
 * history entries, so Android system back / browser back and the top-bar back
 * button pop the same way (§2.4/§2.5).
 */

/** 'botEdit' is the only third-level entry, pushed only on top of 'bots'. */
type MeStackEntry = MeRoute | 'botEdit';

function UserCard(props: {
  identity: ReturnType<typeof useIdentity>['identity'];
  onOpen: () => void;
}): JSX.Element {
  const { identity } = props;
  const syncOk = Boolean(identity && identity.sync_state === 'synced' && !identity.sync_error);
  const shortId = identity?.globalmetaid ? `${identity.globalmetaid.slice(0, 10)}…` : '';
  return (
    <button
      type="button"
      data-testid="user-card"
      onClick={props.onOpen}
      className="twin-panel twin-panel-padded flex min-h-[64px] w-full items-center gap-3 text-left"
    >
      <BotAvatar name={identity?.name} avatar={identity?.avatar} size={48} testId="user-card-avatar" />
      <div className="min-w-0 flex-1">
        <p className="twin-list-title truncate">{identity?.name ?? ''}</p>
        {shortId ? <p className="twin-list-subtitle truncate">{shortId}</p> : null}
      </div>
      {identity && !syncOk ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-red-600" data-testid="user-card-sync-badge" data-state="error">
          <span aria-hidden className="h-2 w-2 rounded-full bg-red-600" />
          {t('mobile.me.profile.syncError')}
        </span>
      ) : (
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-[var(--border-color)]" data-testid="user-card-sync-badge" data-state="ok" />
      )}
      <ChevronRightIcon className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden />
    </button>
  );
}

/**
 * iOS note: the capacitor iOS shell shows the catalog and guidance only —
 * no cashier, no voucher flow (Apple IAP policy, S9 §5). This sheet is the
 * one place that explains where the purchase can be completed.
 */
function IosGuidanceSheet(props: { onClose: () => void }): JSX.Element {
  return (
    <BottomSheet title={t('mobile.me.points.iosTitle')} onClose={props.onClose}>
      <p className="mb-4 text-sm text-[var(--text-secondary)]" data-testid="me-ios-guidance-body">
        {t('mobile.me.points.iosBody')}
      </p>
      <button type="button" className="twin-button twin-button-primary twin-button-full" onClick={props.onClose}>
        {t('mobile.me.points.iosAck')}
      </button>
    </BottomSheet>
  );
}

export default function MeScreen(props: {
  resyncCounter?: number;
  canPurchase: boolean;
  onOpenPurchase: (section: 'subscribe' | 'topup', planId?: string) => void;
  /** Bumped by the shell when a submitted order should open Usage & credits. */
  usageSignal?: number;
}): JSX.Element {
  const identity = useIdentity(props.resyncCounter);
  const [stack, setStack] = useState<MeStackEntry[]>([]);
  const [editingBotId, setEditingBotId] = useState<number | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [iosOpen, setIosOpen] = useState(false);
  const dirtyRef = useRef(false);
  const pushedRef = useRef(0);
  const me = useMeStore();

  // Registry summaries (IA-PLAN §4.1): count/enabled/combo/version.
  const settings = useSettings();
  const memory = useMemorySettings();
  const skills = useSkills();
  const metabots = useMetabots();
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    void getMobileElectron()
      .appInfo.getVersion()
      .then((version) => setAppVersion(version))
      .catch(() => setAppVersion(null));
  }, []);

  const refreshPoints = useCallback(() => {
    void refreshMeBalance({ forceRefresh: true });
    void refreshMeSubscription();
    void refreshMeCatalog();
  }, []);

  useEffect(() => {
    ensureMeOverview();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshPoints();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refreshPoints, props.resyncCounter]);

  const subscribed = isMeSubscribed(me.subscription);
  const activePlanId = meActivePlanId(me.subscription);
  const activeTierKey = meActiveTierKey(me.subscription);
  const expiryMs = meSubscriptionExpiryMs(me.subscription);
  const currentPlan = useMemo(
    () => meCurrentPlan(me.plans, me.subscription),
    [me.plans, me.subscription],
  );
  const meTotal = me.balance ? meFromMilli(me.balance.totalAvailable) : null;

  const top: MeStackEntry | null = stack.length > 0 ? stack[stack.length - 1] : null;

  const pushHistoryEntry = useCallback(() => {
    try {
      window.history.pushState({ idbotsMe: pushedRef.current + 1 }, '');
      pushedRef.current += 1;
    } catch {
      // History unavailable: the top-bar back button still pops via fallback.
    }
  }, []);

  const pushRoute = useCallback((route: MeStackEntry, botId?: number) => {
    dirtyRef.current = false;
    setConfirmDiscard(false);
    if (route === 'botEdit') {
      if (botId === undefined) return;
      setEditingBotId(botId);
    }
    setStack((current) => [...current, route]);
    pushHistoryEntry();
  }, [pushHistoryEntry]);

  const lastUsageSignal = useRef(0);
  useEffect(() => {
    if (!props.usageSignal || props.usageSignal === lastUsageSignal.current) return;
    lastUsageSignal.current = props.usageSignal;
    pushRoute('usage');
  }, [props.usageSignal, pushRoute]);

  const popRoute = useCallback(() => {
    if (top === 'botEdit') setEditingBotId(null);
    dirtyRef.current = false;
    setConfirmDiscard(false);
    setStack((current) => current.slice(0, -1));
  }, [top]);

  /** Top-bar back / discard-confirm back: route through history when we own
   * an entry, so the browser back stack never desyncs from the stack. */
  const requestBack = useCallback(() => {
    if (dirtyRef.current) {
      setConfirmDiscard(true);
      return;
    }
    if (pushedRef.current > 0) window.history.back();
    else popRoute();
  }, [popRoute]);

  // Browser/Android back pops the same stack (§2.4). While a page is dirty,
  // consume the gesture as "ask first" and restore our history entry so the
  // page stays mounted until the confirm sheet is answered.
  useEffect(() => {
    const onPop = () => {
      if (pushedRef.current <= 0) return;
      pushedRef.current -= 1;
      if (dirtyRef.current) {
        pushHistoryEntry();
        setConfirmDiscard(true);
        return;
      }
      if (top === 'botEdit') setEditingBotId(null);
      setStack((current) => current.slice(0, -1));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [top, pushHistoryEntry]);

  // Leaving the Me tab with pages open: give the pushed entries back.
  useEffect(() => () => {
    if (pushedRef.current > 0) {
      try {
        window.history.go(-pushedRef.current);
      } catch {
        // noop
      }
      pushedRef.current = 0;
    }
  }, []);

  const discardAndBack = useCallback(() => {
    dirtyRef.current = false;
    setConfirmDiscard(false);
    if (pushedRef.current > 0) window.history.back();
    else popRoute();
  }, [popRoute]);

  const summaryInput: MeEntrySummaryInput = {
    botCount: metabots.loading && metabots.bots.length === 0 ? null : metabots.bots.length,
    skillsEnabledCount: skills.skills.length === 0 ? null : skills.skills.filter((skill) => skill.enabled).length,
    memoryEnabled: memory.config ? memory.config.memoryEnabled : null,
    languageLabel: t(settings.language === 'zh' ? 'mobile.me.languageZh' : 'mobile.me.languageEn'),
    themeLabel: t(
      settings.theme === 'light'
        ? 'mobile.me.themeLight'
        : settings.theme === 'dark'
          ? 'mobile.me.themeDark'
          : 'mobile.me.themeSystem',
    ),
    appVersion,
    meTotal,
  };

  const openUpgrade = useCallback((planId?: string) => {
    if (!props.canPurchase) {
      setIosOpen(true);
      return;
    }
    props.onOpenPurchase('subscribe', planId);
  }, [props]);

  const openRecharge = useCallback(() => {
    if (!props.canPurchase) {
      setIosOpen(true);
      return;
    }
    props.onOpenPurchase('topup');
  }, [props]);

  if (top) {
    switch (top) {
      case 'profile':
        return (
          <>
            <ProfilePage
              identity={identity.identity}
              onBack={requestBack}
              onDirtyChange={(dirty) => {
                dirtyRef.current = dirty;
              }}
              onNameSaved={() => identity.reload()}
            />
            {confirmDiscard ? <DiscardConfirmSheet onCancel={() => setConfirmDiscard(false)} onDiscard={discardAndBack} /> : null}
          </>
        );
      case 'usage':
        return <UsageCreditsPage onBack={requestBack} />;
      case 'bots':
        return <BotsPage onBack={requestBack} onOpenEdit={(botId) => pushRoute('botEdit', botId)} />;
      case 'weixinBind':
        return <WeixinBindPage onBack={requestBack} />;
      case 'botEdit':
        return (
          <>
            <BotEditPage
              botId={editingBotId}
              onBack={requestBack}
              onSaved={requestBack}
              onDirtyChange={(dirty) => {
                dirtyRef.current = dirty;
              }}
            />
            {confirmDiscard ? <DiscardConfirmSheet onCancel={() => setConfirmDiscard(false)} onDiscard={discardAndBack} /> : null}
          </>
        );
      case 'skills':
        return <SkillsPage onBack={requestBack} />;
      case 'memory':
        return <MemoryPage onBack={requestBack} />;
      case 'general':
        return <GeneralPage onBack={requestBack} />;
      case 'account':
        return <AccountPage onBack={requestBack} />;
      case 'about':
        return <AboutPage onBack={requestBack} />;
    }
  }

  return (
    <div className="twin-page">
      <div className="twin-topbar twin-topbar-simple">
        <div>
          <h1 className="twin-title">{t('mobile.me.title')}</h1>
          <p className="twin-subtitle">{t('mobile.me.subtitle')}</p>
        </div>
        <MeBalanceChip balance={me.balance} loading={me.balanceLoading} onOpen={() => pushRoute('usage')} />
      </div>
      <div className="twin-scroll space-y-3 p-3" data-testid="me-primary-page">
        <UserCard identity={identity.identity} onOpen={() => pushRoute('profile')} />
        <MePointsHero
          balance={me.balance}
          loading={me.balanceLoading}
          error={me.balanceError}
          featureUnavailable={me.balanceFeatureUnavailable}
          plan={currentPlan}
          subscribed={subscribed}
          expiryMs={expiryMs}
          canPurchase={props.canPurchase}
          onUpgrade={() => openUpgrade(activePlanId || undefined)}
          onRecharge={openRecharge}
          onOpenUsage={() => pushRoute('usage')}
          onRetry={refreshPoints}
        />
        <MeTierCards
          plans={me.plans}
          loading={me.plansLoading}
          error={me.plansError}
          activePlanId={activePlanId}
          activeTierKey={activeTierKey}
          subscribed={subscribed}
          selectedPlanId=""
          onChoose={(planId) => openUpgrade(planId)}
          onRetry={() => void refreshMeCatalog()}
        />
        {ME_ENTRY_GROUPS.map((group) => (
          <div key={group.group}>
            {group.titleKey ? <p className="twin-section-label">{t(group.titleKey)}</p> : null}
            <div className="twin-list" data-testid={`me-group-${group.group}`}>
              {meEntriesForGroup(group.group).map((entry) => {
                const Icon = entry.icon;
                const summary = entry.summary ? entry.summary(summaryInput) : null;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    data-testid={entry.testId}
                    onClick={() => pushRoute(entry.id)}
                    className={`twin-list-row ${entry.danger ? 'text-red-600' : ''}`}
                  >
                    <span className="twin-list-leading"><Icon className="h-5 w-5" aria-hidden /></span>
                    <span className="twin-list-copy">
                      <span className="twin-list-title">{t(entry.titleKey)}</span>
                    </span>
                    {summary ? (
                      <span className="twin-list-value" data-testid={`${entry.testId}-summary`}>
                        {summary}
                      </span>
                    ) : null}
                    <ChevronRightIcon className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {iosOpen ? <IosGuidanceSheet onClose={() => setIosOpen(false)} /> : null}
    </div>
  );
}

function DiscardConfirmSheet(props: { onCancel: () => void; onDiscard: () => void }): JSX.Element {
  return (
    <BottomSheet title={t('mobile.me.discardTitle')} onClose={props.onCancel}>
      <p className="mb-4 text-sm text-[var(--text-secondary)]">{t('mobile.me.discardBody')}</p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={props.onCancel}
          className="twin-button twin-button-primary flex-1"
        >
          {t('mobile.me.discardCancel')}
        </button>
        <button
          type="button"
          data-testid="discard-confirm"
          onClick={props.onDiscard}
          className="twin-button twin-button-secondary flex-1 active:bg-[var(--bg-hover)]"
        >
          {t('mobile.me.discardConfirm')}
        </button>
      </div>
    </BottomSheet>
  );
}
