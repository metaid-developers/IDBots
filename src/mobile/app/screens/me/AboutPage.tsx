import { useEffect, useState } from 'react';
import { t } from '../../../i18n';
import { CONTRACT_VERSION } from '../../../bridge/types';
import { getMobileElectron } from '../../appBridge';
import { getNativeAdapter } from '../../../native/nativeAdapter';
import { SecondaryPageShell } from './SecondaryPageShell';
import { mobileLegalUrl } from '../../../legal';

/**
 * about secondary page (IA-PLAN v1 §4.10): version info + the three legal
 * pages already live behind #8, opened in the system browser. Link URLs
 * follow the deployed environment rather than pinning production users to staging.
 */
const LEGAL_LINKS: ReadonlyArray<{ key: string; document: 'terms' | 'privacy' | 'custody'; testId: string }> = [
  { key: 'mobile.me.about.terms', document: 'terms', testId: 'about-link-terms' },
  { key: 'mobile.me.about.privacy', document: 'privacy', testId: 'about-link-privacy' },
  { key: 'mobile.me.about.custody', document: 'custody', testId: 'about-link-custody' },
];

type UpdateCheckStatus = 'checking' | 'update-available' | 'up-to-date' | 'check-failed';

export function AboutPage(props: { onBack: () => void }): JSX.Element {
  const adapter = typeof window === 'undefined' ? null : getNativeAdapter();
  const nativeApp = adapter?.getAppVersion() ?? null;
  const updateChecks = adapter?.getCapabilities().updateChecks === true;
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateCheckStatus | null>(null);
  useEffect(() => {
    void getMobileElectron()
      .appInfo.getVersion()
      .then((version) => setAppVersion(version))
      .catch(() => setAppVersion(null));
  }, []);
  const checkForUpdate = async (): Promise<void> => {
    setUpdateStatus('checking');
    if (!adapter) {
      setUpdateStatus('check-failed');
      return;
    }
    try {
      setUpdateStatus(await adapter.checkForUpdate());
    } catch {
      setUpdateStatus('check-failed');
    }
  };
  return (
    <SecondaryPageShell title={t('mobile.me.entry.about')} onBack={props.onBack} testId="me-page-about">
      <div className="flex flex-col items-center gap-2 twin-panel twin-panel-padded">
        <img
          src="/app/icon-192.png"
          alt="IDBots"
          className="h-16 w-16 rounded-2xl border border-[var(--border-color)] object-cover"
        />
        {nativeApp ? (
          <p className="text-sm text-[var(--text-secondary)]" data-testid="about-native-app-version">
            {t('mobile.me.nativeVersion', { version: nativeApp.versionName, build: nativeApp.versionCode })}
          </p>
        ) : null}
        <p className="text-sm text-[var(--text-secondary)]" data-testid="about-app-version">
          {t('mobile.me.cloudVersion', { version: appVersion ?? '—' })}
        </p>
        <p className="text-sm text-[var(--text-secondary)]">
          {t('mobile.me.protocolVersion', { version: CONTRACT_VERSION })}
        </p>
        <p className="max-w-xs text-center text-xs text-[var(--text-secondary)]">
          {t('mobile.me.protocolHint')}
        </p>
        {updateChecks ? (
          <>
            <button
              type="button"
              className="twin-button twin-button-secondary twin-button-full mt-2"
              data-testid="about-check-update"
              disabled={updateStatus === 'checking'}
              onClick={() => void checkForUpdate()}
            >
              {t(updateStatus === 'checking' ? 'mobile.me.about.checking' : 'mobile.me.about.checkUpdate')}
            </button>
            {updateStatus && updateStatus !== 'checking' ? (
              <p className="text-center text-xs text-[var(--text-secondary)]" data-testid="about-update-status">
                {t(`mobile.me.about.${updateStatus}`)}
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="twin-panel twin-panel-padded">
        {LEGAL_LINKS.map((link) => (
          <a
            key={link.testId}
            href={mobileLegalUrl(link.document)}
            target="_blank"
            rel="noreferrer"
            data-testid={link.testId}
            className="twin-list-row"
          >
            {t(link.key)}
            <span aria-hidden className="text-[var(--text-secondary)]">›</span>
          </a>
        ))}
      </div>

      <p className="px-1 text-center text-xs text-[var(--text-secondary)]">{t('mobile.me.about.copyright')}</p>
    </SecondaryPageShell>
  );
}
