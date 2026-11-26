import { useEffect, useState } from 'react';
import { t } from './loginI18n';
import { getMe } from './loginApi';
import type { LoginTenant } from './loginApi';
import { mobileLegalUrl } from '../legal';
import { sanitizeMobileReturnPath } from '../app/notifications/notificationRoutes';
import { useLoginStyles } from './loginStyleHooks';

const PREPARE_POLL_MS = 3000;

function postLoginDestination(): string {
  return sanitizeMobileReturnPath(new URLSearchParams(window.location.search).get('returnTo'));
}

export default function PreparingScreen(props: { onSignOut: () => void }): JSX.Element {
  const styles = useLoginStyles();
  const [tenant, setTenant] = useState<LoginTenant | null>(null);
  const [pollFailed, setPollFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let navigated = false;
    let retryPending = retryNonce > 0;
    let timer: number | undefined;
    const tick = async () => {
      const requestRetry = retryPending;
      retryPending = false;
      try {
        const me = await getMe(requestRetry ? { retry: true } : undefined);
        if (cancelled || navigated) return;
        setTenant(me.tenant);
        setPollFailed(false);
        if (me.tenant.status === 'ready' || me.tenant.status === 'degraded') {
          navigated = true;
          window.location.replace(postLoginDestination());
          return;
        }
        if (me.tenant.status === 'failed' && timer !== undefined) {
          window.clearInterval(timer);
          timer = undefined;
        }
      } catch {
        if (!cancelled) setPollFailed(true);
      }
    };
    void tick();
    timer = window.setInterval(() => void tick(), PREPARE_POLL_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearInterval(timer);
      }
    };
  }, [retryNonce]);

  useEffect(() => {
    const timer = window.setInterval(() => setElapsedSec((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const retry = () => {
    setTenant(null);
    setPollFailed(false);
    setRetryNonce((value) => value + 1);
  };
  const failed = tenant?.status === 'failed';

  return (
    <div style={styles.page}>
      <img src="/icon-192.png" alt="IDBots" style={styles.logo} />
      <h1 style={styles.title}>{t('mobile.login.preparingTitle')}</h1>
      <p style={styles.statusWord} role="status">
        {t(`mobile.login.preparingStatus.${tenant?.status ?? 'provisioning'}`)}
      </p>
      {!failed && <p style={styles.note}>{t('mobile.login.preparingNote')}</p>}
      <p style={styles.noteSmall}>{t('mobile.login.preparingElapsed', { sec: elapsedSec })}</p>
      {pollFailed && !failed ? <p style={styles.error}>{t('mobile.login.preparingPollFailed')}</p> : null}
      {failed ? <p style={styles.error}>{t('mobile.login.preparingFailedGeneric')}</p> : null}
      {failed || pollFailed ? (
        <div style={styles.preparingActions}>
          <button type="button" style={styles.button} onClick={retry}>{t('mobile.common.retry')}</button>
          <a href={mobileLegalUrl('support')} target="_blank" rel="noreferrer" style={styles.link}>
            {t('mobile.login.supportAction')}
          </a>
        </div>
      ) : null}
      <button type="button" style={styles.textButton} onClick={props.onSignOut}>
        {t('mobile.login.signOut')}
      </button>
    </div>
  );
}
