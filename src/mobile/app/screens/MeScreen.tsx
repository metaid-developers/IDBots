import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRightIcon } from '@heroicons/react/24/outline';
import { t } from '../../i18n';
import { getMobileElectron } from '../appBridge';
import { useIdentity } from '../hooks/useIdentity';
import { useMeters } from '../hooks/useMeters';
import { useSettings } from '../hooks/useSettings';
import { useMemorySettings } from '../hooks/useMemorySettings';
import { useSkills } from '../hooks/useSkills';
import { useMetabots } from '../hooks/useMetabots';
import { formatBytes, formatCount } from '../format';
import { BotAvatar } from '../components/BotAvatar';
import { RedeemButton } from '../components/RedeemButton';
import { BottomSheet } from '../components/BottomSheet';
import { Section } from '../components/Section';
import {
  ME_ENTRY_GROUPS,
  meEntriesForGroup,
  type MeEntrySummaryInput,
  type MeRoute,
} from './me/registry';
import { ProfilePage } from './me/ProfilePage';
import { TrafficPage } from './me/TrafficPage';
import { BotsPage } from './me/BotsPage';
import { BotEditPage } from './me/BotEditPage';
import { SkillsPage } from './me/SkillsPage';
import { MemoryPage } from './me/MemoryPage';
import { GeneralPage } from './me/GeneralPage';
import { AccountPage } from './me/AccountPage';
import { WeixinBindPage } from './me/WeixinBindPage';
import { AboutPage } from './me/AboutPage';

/**
 * Me tab (REQ-E-14), A6 settings IA rework (IA-PLAN v1):
 * primary page = user card + balance card + registry-rendered entry list;
 * every entry pushes a secondary page on a local stack. No router
 * dependency — the stack rides on history entries so Android system back /
 * browser back and the top-bar back button pop the same way (§2.4/§2.5).
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
 * Balance card: the whole card opens the traffic page while the recharge
 * button keeps its one-tap path into the cashier overlay (IA-PLAN §2.2 —
 * the conversion path stays one jump; hard gate 2 depends on it).
 * rechargeAllowed=false (native shell, NS1 policy) hides the web cashier
 * entry while the card itself stays tappable into the traffic page.
 */
function BalanceCard(props: {
  resyncCounter?: number;
  onOpenRecharge: () => void;
  onOpenTraffic: () => void;
  rechargeAllowed?: boolean;
}): JSX.Element {
  const { meters, loading, error, reload } = useMeters(props.resyncCounter);
  // Desktop parity threshold (TrafficSettings TRAFFIC_LOW_BALANCE_BYTES).
  const lowBalance = Boolean(meters?.traffic && meters.traffic.balanceBytes < 5_000_000);
  return (
    <Section title={t('mobile.me.balanceTitle')}>
      <div
        role="button"
        tabIndex={0}
        data-testid="balance-card"
        onClick={props.onOpenTraffic}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') props.onOpenTraffic();
        }}
        className="mb-3 cursor-pointer rounded-xl"
      >
        <div className="flex gap-3">
          <div className="twin-panel-flat flex-1 rounded-xl bg-[var(--bg-main)] p-3">
            <p className="text-xs text-[var(--text-secondary)]">{t('mobile.me.trafficLabel')}</p>
            <p className="twin-card-value">
              {meters?.traffic ? formatBytes(meters.traffic.balanceBytes) : '—'}
            </p>
          </div>
          <div className="twin-panel-flat flex-1 rounded-xl bg-[var(--bg-main)] p-3">
            <p className="text-xs text-[var(--text-secondary)]">{t('mobile.me.llmLabel')}</p>
            <p className="twin-card-value">
              {meters ? `${formatCount(meters.llm.quotaRemaining)} ${meters.llm.unit}` : '—'}
            </p>
          </div>
        </div>
        {lowBalance ? (
          <p className="twin-help text-[var(--twin-warning)]" data-testid="balance-low-warning">
            {t('mobile.me.traffic.lowBalance')}
          </p>
        ) : null}
      </div>
      {loading ? <p className="mb-2 text-xs text-[var(--text-secondary)]">{t('mobile.common.loading')}</p> : null}
      {error ? (
        <div className="mb-2 flex items-center justify-between gap-2" data-testid="balance-load-error">
          <p className="text-xs text-red-600">{t('mobile.me.balanceLoadFailed')}</p>
          <button type="button" onClick={() => void reload()} className="twin-button twin-button-ghost twin-button-small">
            {t('mobile.common.retry')}
          </button>
        </div>
      ) : null}
      <div className="flex gap-2">
        {props.rechargeAllowed !== false ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onOpenRecharge();
            }}
            className="twin-button twin-button-primary flex-1"
          >
            {t('mobile.me.rechargeEntry')}
          </button>
        ) : null}
        <RedeemButton />
      </div>
    </Section>
  );
}

export default function MeScreen(props: {
  resyncCounter?: number;
  onOpenRecharge: () => void;
  rechargeAllowed?: boolean;
}): JSX.Element {
  const identity = useIdentity(props.resyncCounter);
  const [stack, setStack] = useState<MeStackEntry[]>([]);
  const [editingBotId, setEditingBotId] = useState<number | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirtyRef = useRef(false);
  const pushedRef = useRef(0);

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
  };

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
      case 'traffic':
        return (
          <TrafficPage
            onBack={requestBack}
            onOpenRecharge={props.onOpenRecharge}
            rechargeAllowed={props.rechargeAllowed}
            resyncCounter={props.resyncCounter}
          />
        );
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
      </div>
      <div className="twin-scroll space-y-3 p-3" data-testid="me-primary-page">
        <UserCard identity={identity.identity} onOpen={() => pushRoute('profile')} />
        <BalanceCard
          resyncCounter={props.resyncCounter}
          onOpenRecharge={props.onOpenRecharge}
          onOpenTraffic={() => pushRoute('traffic')}
          rechargeAllowed={props.rechargeAllowed}
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
