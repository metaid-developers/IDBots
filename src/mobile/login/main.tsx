/**
 * Mobile login entry (REQ-E-10): full SMS sign-in / invite-only sign-up flow
 * on top of the loginApi C3 seam — every action goes through loginApi, no
 * fetch and no hard-coded outcomes, so wiring the real control plane later
 * only changes loginApi.ts.
 *
 * Also renders the WeChat/QQ in-app browser guide (those webviews cannot
 * finish sign-in) and the iPhone Safari "Add to Home Screen" hint.
 *
 * The theme follows the same stored preference as the app: the app settings
 * service mirrors the confirmed `app_config.theme` into localStorage
 * (themeMirror.ts) and this entry resolves it synchronously pre-paint
 * (login/theme.ts), falling back to the OS scheme like the app's `system`
 * default. Styling stays inline, keyed on the palette in loginStyles.ts.
 *
 * The import graph stays tiny (react + mobile i18n + loginApi +
 * inAppBrowser + theme/loginStyles): the control plane serves this bundle
 * before any session exists and it must fit the 80 KB gzip budget
 * (REQ-E-19). No desktop i18n, no redux, no Tailwind, no window.electron:
 * styling is inline.
 */

import '../native/installNativeBootstrapFirst';
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { mobileI18n, t } from './loginI18n';
import {
  copyTextToClipboard,
  isInAppBrowser,
  isIosSafari,
  isStandaloneDisplay,
} from './inAppBrowser';
import { getMe, logout, sendCode, verifyCode } from './loginApi';
import { probeSessionRecovery } from './sessionRecovery';
import { mobileLegalUrl } from '../legal';
import { LoginPlaceholderStyle, useLoginStyles } from './loginStyleHooks';

const PreparingScreen = React.lazy(() => import('./PreparingScreen'));

mobileI18n.initFromDeviceLocale();

const DISPLAY_NAME_MIN = 1;
const DISPLAY_NAME_MAX = 24;

function normalizePhone(input: string): string {
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{11}$/.test(digits) ? `+86${digits}` : digits;
}

function isValidDisplayName(name: string): boolean {
  const length = name.trim().length;
  return length >= DISPLAY_NAME_MIN && length <= DISPLAY_NAME_MAX;
}

function readErrorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** Localized copy for every loginApi error code the sign-in path can hit. */
function verifyErrorText(code: string | undefined): string {
  switch (code) {
    case 'INVITE_REQUIRED':
      return t('mobile.login.inviteRequired');
    case 'INVITE_INVALID':
      return t('mobile.login.inviteInvalid');
    case 'INVITE_EXHAUSTED':
      return t('mobile.login.inviteExhausted');
    case 'CODE_EXPIRED':
      return t('mobile.login.codeExpired');
    case 'CODE_INVALID':
      return t('mobile.login.invalidCode');
    default:
      return t('mobile.login.genericError');
  }
}

function SessionRecoveryScreen(props: { failed: boolean; onRetry: () => void }): JSX.Element {
  const styles = useLoginStyles();
  return (
    <div style={styles.page}>
      <img src="/icon-192.png" alt="IDBots" style={styles.logo} />
      <h1 style={styles.title}>{t(props.failed ? 'mobile.login.restoreFailed' : 'mobile.login.restoreTitle')}</h1>
      {props.failed ? (
        <button type="button" style={styles.button} onClick={props.onRetry}>
          {t('mobile.common.retry')}
        </button>
      ) : null}
    </div>
  );
}

function LoginPage(): JSX.Element {
  const styles = useLoginStyles();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errorField, setErrorField] = useState<'phone' | 'code' | 'invite' | 'displayName' | 'general'>('general');
  const [inviteVisible, setInviteVisible] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [displayNameVisible, setDisplayNameVisible] = useState(false);
  const [displayName, setDisplayName] = useState(() => t('mobile.login.displayNameDefault'));
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [hkConsent, setHkConsent] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [sessionState, setSessionState] = useState<'checking' | 'login' | 'retry'>('checking');
  const [sessionAttempt, setSessionAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSessionState('checking');
    void probeSessionRecovery(getMe).then((action) => {
      if (cancelled) return;
      if (action === 'open-app') {
        window.location.replace('/app/');
        return;
      }
      if (action === 'preparing') {
        setPreparing(true);
        return;
      }
      setSessionState(action);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionAttempt]);

  // 1 s ticks for the resend countdown started by sendCode's resendAfterSec.
  useEffect(() => {
    if (countdown <= 0) {
      return undefined;
    }
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  const clearError = () => {
    setError('');
    setErrorField('general');
  };
  const showError = (message: string, field: 'phone' | 'code' | 'invite' | 'displayName' | 'general' = 'general') => {
    setError(message);
    setErrorField(field);
  };

  const normalizedPhone = normalizePhone(phone);
  const displayNameReady = !displayNameVisible || isValidDisplayName(displayName);
  const canSignIn = !busy && code.length > 0 && agreeTerms && hkConsent && displayNameReady;

  const onSendCode = async () => {
    setBusy(true);
    clearError();
    try {
      const result = await sendCode(normalizedPhone);
      setCodeSent(true);
      setCountdown(result.resendAfterSec);
    } catch (sendError) {
      showError(
        readErrorCode(sendError) === 'INVALID_PHONE'
          ? t('mobile.login.invalidPhone')
          : t('mobile.login.genericError'),
        readErrorCode(sendError) === 'INVALID_PHONE' ? 'phone' : 'general',
      );
    } finally {
      setBusy(false);
    }
  };

  const onVerify = async () => {
    if (!canSignIn) {
      return;
    }
    setBusy(true);
    clearError();
    try {
      await verifyCode(normalizedPhone, code, {
        inviteCode: inviteVisible && inviteCode.trim() ? inviteCode.trim() : undefined,
        displayName: displayNameVisible ? displayName.trim() : undefined,
      });
      setPreparing(true);
    } catch (verifyError) {
      const errorCode = readErrorCode(verifyError);
      // Sign-up path: a new account needs an invite and picks the on-chain
      // display name before the next verify attempt.
      if (errorCode === 'INVITE_REQUIRED') {
        setInviteVisible(true);
        setDisplayNameVisible(true);
      }
      const field = errorCode === 'CODE_INVALID' || errorCode === 'CODE_EXPIRED'
        ? 'code'
        : errorCode?.startsWith('INVITE_')
          ? 'invite'
          : 'general';
      showError(verifyErrorText(errorCode), field);
    } finally {
      setBusy(false);
    }
  };

  const onSignOut = async () => {
    try {
      await logout();
    } finally {
      setPreparing(false);
      setSessionState('login');
    }
  };

  if (preparing) {
    return (
      <React.Suspense fallback={<div style={styles.page}><p style={styles.note}>{t('mobile.login.preparingTitle')}</p></div>}>
        <PreparingScreen
          onSignOut={() => {
            void onSignOut();
          }}
        />
      </React.Suspense>
    );
  }

  if (sessionState !== 'login') {
    return (
      <SessionRecoveryScreen
        failed={sessionState === 'retry'}
        onRetry={() => setSessionAttempt((value) => value + 1)}
      />
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.loginCard}>
      <img src="/icon-192.png" alt="IDBots" style={styles.logo} />
      <h1 style={styles.title}>{t('mobile.login.title')}</h1>
      <p style={styles.subtitle}>{t('mobile.login.subtitle')}</p>
      <div style={styles.field}>
        <label htmlFor="login-phone" style={styles.label}>{t('mobile.login.phoneLabel')}</label>
        <input
          id="login-phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(event) => {
            setPhone(event.target.value);
            clearError();
          }}
          placeholder={t('mobile.login.phonePlaceholder')}
          style={styles.input}
          aria-invalid={errorField === 'phone' && Boolean(error)}
        />
        {errorField === 'phone' && error ? <p style={styles.errorLeft} role="alert">{error}</p> : null}
      </div>
      <button
        type="button"
        onClick={onSendCode}
        disabled={busy || !phone || countdown > 0}
        style={{ ...styles.button, ...((busy || !phone || countdown > 0) ? styles.buttonDisabled : null) }}
      >
        {busy ? t('mobile.login.sending') : countdown > 0 ? t('mobile.login.resendIn', { sec: countdown }) : t('mobile.login.sendCode')}
      </button>
      {codeSent && (
        <>
          <div style={styles.field}>
            <label htmlFor="login-code" style={styles.label}>{t('mobile.login.codeLabel')}</label>
            <input
              id="login-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => {
                setCode(event.target.value.replace(/\D/g, '').slice(0, 6));
                clearError();
              }}
              placeholder={t('mobile.login.codePlaceholder')}
              style={styles.input}
              aria-invalid={errorField === 'code' && Boolean(error)}
            />
            {errorField === 'code' && error ? <p style={styles.errorLeft} role="alert">{error}</p> : null}
          </div>
          {inviteVisible && (
            <div style={styles.field}>
              <label htmlFor="login-invite" style={styles.label}>{t('mobile.login.inviteLabel')}</label>
              <input
                id="login-invite"
                type="text"
                autoCapitalize="characters"
                autoCorrect="off"
                value={inviteCode}
                onChange={(event) => {
                  setInviteCode(event.target.value);
                  clearError();
                }}
                placeholder={t('mobile.login.invitePlaceholder')}
                style={styles.input}
                aria-invalid={errorField === 'invite' && Boolean(error)}
              />
              {errorField === 'invite' && error ? <p style={styles.errorLeft} role="alert">{error}</p> : null}
            </div>
          )}
          {displayNameVisible && (
            <div style={styles.field}>
              <label htmlFor="login-display-name" style={styles.label}>{t('mobile.login.displayNameLabel')}</label>
              <input
                id="login-display-name"
                type="text"
                autoComplete="nickname"
                maxLength={DISPLAY_NAME_MAX}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={t('mobile.login.displayNamePlaceholder')}
                style={styles.input}
                aria-invalid={!displayNameReady}
              />
              <p style={styles.note}>{t('mobile.login.displayNameNote')}</p>
              {!displayNameReady && <p style={styles.errorLeft} role="alert">{t('mobile.login.displayNameInvalid')}</p>}
            </div>
          )}
          <label style={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={agreeTerms}
              onChange={(event) => setAgreeTerms(event.target.checked)}
            />
            <span>
              {t('mobile.login.termsPrefix')}{' '}
              <a
                href={mobileLegalUrl('terms')}
                target="_blank"
                rel="noreferrer"
                style={styles.link}
              >
                {t('mobile.login.termsLink')}
              </a>{' '}
              {t('mobile.login.conjunction')}{' '}
              <a
                href={mobileLegalUrl('privacy')}
                target="_blank"
                rel="noreferrer"
                style={styles.link}
              >
                {t('mobile.login.privacyLink')}
              </a>
            </span>
          </label>
          {/* Data-residency consent wording is pending legal review before launch. */}
          <label style={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={hkConsent}
              onChange={(event) => setHkConsent(event.target.checked)}
            />
            <span>{t('mobile.login.hkDataConsent')}</span>
          </label>
          <button type="button" onClick={onVerify} disabled={!canSignIn} style={{ ...styles.button, ...(!canSignIn ? styles.buttonDisabled : null) }}>
            {busy ? t('mobile.login.verifying') : t('mobile.login.verify')}
          </button>
        </>
      )}
      {errorField === 'general' && error ? <p style={styles.error} role="alert">{error}</p> : null}
      <p style={styles.noteSmall}>{t('mobile.login.demoNote')}</p>
      </div>
    </div>
  );
}

/** Half-screen guide shown INSTEAD of the login form inside WeChat/QQ webviews. */
function InAppBrowserGuide(): JSX.Element {
  const styles = useLoginStyles();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const onCopyLink = async () => {
    const copied = await copyTextToClipboard(window.location.href);
    setCopyState(copied ? 'copied' : 'failed');
  };

  return (
    <div style={styles.guidePage}>
      <div style={styles.guideSheet}>
        <h1 style={styles.title}>{t('mobile.login.inAppTitle')}</h1>
        <p style={styles.subtitleLeft}>{t('mobile.login.inAppBody')}</p>
        <button
          type="button"
          style={styles.button}
          onClick={() => {
            void onCopyLink();
          }}
        >
          {t('mobile.login.copyLink')}
        </button>
        {copyState === 'copied' && <p style={styles.note}>{t('mobile.login.linkCopied')}</p>}
        {copyState === 'failed' && <p style={styles.error}>{t('mobile.login.copyFailed')}</p>}
      </div>
    </div>
  );
}

/** Dismissible iPhone Safari hint about Share -> Add to Home Screen. */
function A2hsHint(): JSX.Element | null {
  const styles = useLoginStyles();
  const [visible, setVisible] = useState(
    () =>
      typeof navigator !== 'undefined' &&
      isIosSafari(navigator.userAgent) &&
      !isStandaloneDisplay(),
  );
  if (!visible) {
    return null;
  }
  return (
    <div style={styles.a2hsCard}>
      <div style={{ flex: 1 }}>
        <p style={styles.a2hsTitle}>{t('mobile.login.a2hsTitle')}</p>
        <p style={styles.noteSmall}>{t('mobile.login.a2hsBody')}</p>
      </div>
      <button type="button" style={styles.a2hsDismiss} onClick={() => setVisible(false)}>
        {t('mobile.login.a2hsDismiss')}
      </button>
    </div>
  );
}

function MobileLoginRoot(): JSX.Element {
  if (typeof navigator !== 'undefined' && isInAppBrowser(navigator.userAgent)) {
    return <InAppBrowserGuide />;
  }
  return (
    <>
      <LoginPlaceholderStyle />
      <LoginPage />
      <A2hsHint />
    </>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find the root element');
}
ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <MobileLoginRoot />
  </React.StrictMode>,
);
