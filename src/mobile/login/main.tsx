/**
 * Mobile login entry (REQ-E-10 + CR-WSE-005 Variant A): minimalist segmented
 * SMS sign-in / invited sign-up flow on top of the loginApi seam.
 *
 * Also renders the WeChat/QQ in-app browser guide and the iPhone Safari
 * "Add to Home Screen" hint while keeping the bundle well within the 80 KB
 * gzip budget (REQ-E-19): no desktop i18n, no redux, no Tailwind, no
 * window.electron.
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
import {
  getMe,
  logout,
  previewInvite,
  sendCode,
  verifyCode,
  type InvitePreviewResult,
} from './loginApi';
import { probeSessionRecovery } from './sessionRecovery';
import { mobileLegalUrl } from '../legal';
import { LoginPlaceholderStyle, useLoginStyles } from './loginStyleHooks';

const PreparingScreen = React.lazy(() => import('./PreparingScreen'));

mobileI18n.initFromDeviceLocale();

type LoginTab = 'signin' | 'signup';
type ErrorField = 'phone' | 'code' | 'invite' | 'general';

function readInitialInviteParam(): string {
  if (typeof window === 'undefined') return '';
  try {
    const raw = new URLSearchParams(window.location.search).get('invite') ?? '';
    return raw.trim().toUpperCase().slice(0, 32);
  } catch {
    return '';
  }
}

function normalizePhone(input: string): string {
  let digits = input.replace(/[\s-]/g, '');
  if (/^\+?86\d{11}$/.test(digits)) {
    digits = digits.replace(/^\+?86/, '');
  }
  return /^\d{11}$/.test(digits) ? `+86${digits}` : digits;
}

function readErrorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function authErrorText(code: string | undefined): string {
  switch (code) {
    case 'INVALID_PHONE':
      return t('mobile.login.invalidPhone');
    case 'INVITE_REQUIRED':
      return t('mobile.login.inviteRequired');
    case 'INVITE_INVALID':
    case 'INVALID_INVITE_CODE':
      return t('mobile.login.inviteInvalid');
    case 'INVITE_EXHAUSTED':
      return t('mobile.login.inviteExhausted');
    case 'INVITE_DAILY_CAP_FULL':
      return t('mobile.login.inviteDailyCapFull');
    case 'INVITE_DISABLED':
      return t('mobile.login.inviteDisabled');
    case 'SMS_SEND_FAILED':
      return t('mobile.login.smsSendFailed');
    case 'RATE_LIMITED':
      return t('mobile.login.rateLimited');
    case 'TOO_MANY_ATTEMPTS':
      return t('mobile.login.tooManyAttempts');
    case 'USER_DISABLED':
      return t('mobile.login.userDisabled');
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
  const [initialInvite] = useState(readInitialInviteParam);
  const [activeTab, setActiveTab] = useState<LoginTab>(() => (initialInvite ? 'signup' : 'signin'));
  const [inviteCode, setInviteCode] = useState(initialInvite);
  const [invitePreview, setInvitePreview] = useState<InvitePreviewResult | null>(null);
  const [capFullAlert, setCapFullAlert] = useState(false);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [sendingCode, setSendingCode] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [errorField, setErrorField] = useState<ErrorField>('general');
  const [agreed, setAgreed] = useState(false);
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

  useEffect(() => {
    if (countdown <= 0) {
      return undefined;
    }
    const timer = window.setTimeout(() => setCountdown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  useEffect(() => {
    const trimmed = inviteCode.trim();
    if (activeTab !== 'signup' || trimmed.length < 3) {
      setInvitePreview(null);
      if (!trimmed) setCapFullAlert(false);
      return undefined;
    }
    let cancelled = false;
    const delayMs = trimmed === initialInvite ? 0 : 180;
    const timer = window.setTimeout(() => {
      void previewInvite(trimmed)
        .then((res) => {
          if (cancelled) return;
          setInvitePreview(res);
          setCapFullAlert(Boolean(res.dailyCapFull));
        })
        .catch(() => {
          if (!cancelled) {
            setInvitePreview(null);
          }
        });
    }, delayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeTab, inviteCode, initialInvite]);

  const clearError = () => {
    setError('');
    setErrorField('general');
  };

  const showError = (message: string, field: ErrorField = 'general') => {
    setError(message);
    setErrorField(field);
  };

  const switchTab = (tab: LoginTab) => {
    setActiveTab(tab);
    clearError();
    if (tab === 'signin') {
      setCapFullAlert(false);
    }
  };

  const onPasteInvite = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return;
    try {
      const clip = (await navigator.clipboard.readText()).trim();
      if (!clip) return;
      const match = clip.match(/[?&]invite=([A-Za-z0-9_-]{3,32})/i);
      const extracted = (match ? match[1] : clip).toUpperCase().replace(/\s+/g, '').slice(0, 32);
      if (extracted) {
        setInviteCode(extracted);
        clearError();
      }
    } catch {
      // Clipboard read permission denied; ignore silently so user can type manually.
    }
  };

  const normalizedPhone = normalizePhone(phone);
  const busy = sendingCode || verifying;
  const capacityBlocked = activeTab === 'signup' && capFullAlert;
  const sendDisabled = busy || !phone || countdown > 0 || capacityBlocked;
  const canSubmit = !busy && Boolean(phone) && code.length > 0 && agreed && !capacityBlocked;

  const onSendCode = async () => {
    if (sendDisabled) return;
    clearError();
    if (activeTab === 'signup' && !inviteCode.trim()) {
      showError(t('mobile.login.inviteRequired'), 'invite');
      return;
    }
    setSendingCode(true);
    try {
      const result = await sendCode(
        normalizedPhone,
        'login',
        activeTab === 'signup' ? { inviteCode: inviteCode.trim() } : undefined,
      );
      setCountdown(result.resendAfterSec);
    } catch (sendError) {
      const errCode = readErrorCode(sendError);
      if (errCode === 'INVITE_DAILY_CAP_FULL') {
        setActiveTab('signup');
        setCapFullAlert(true);
        return;
      }
      if (errCode === 'INVITE_REQUIRED') {
        setActiveTab('signup');
        showError(authErrorText(errCode), 'invite');
        return;
      }
      if (errCode?.startsWith('INVITE_')) {
        setActiveTab('signup');
        showError(authErrorText(errCode), 'invite');
        return;
      }
      showError(authErrorText(errCode), errCode === 'INVALID_PHONE' ? 'phone' : 'general');
    } finally {
      setSendingCode(false);
    }
  };

  const onVerify = async () => {
    if (!canSubmit) return;
    clearError();
    if (activeTab === 'signup' && !inviteCode.trim()) {
      showError(t('mobile.login.inviteRequired'), 'invite');
      return;
    }
    setVerifying(true);
    try {
      await verifyCode(normalizedPhone, code, {
        inviteCode: activeTab === 'signup' && inviteCode.trim() ? inviteCode.trim() : undefined,
      });
      setPreparing(true);
    } catch (verifyError) {
      const errCode = readErrorCode(verifyError);
      if (errCode === 'INVITE_DAILY_CAP_FULL') {
        setActiveTab('signup');
        setCapFullAlert(true);
        return;
      }
      if (errCode === 'INVITE_REQUIRED') {
        setActiveTab('signup');
        showError(authErrorText(errCode), 'invite');
        return;
      }
      const field: ErrorField =
        errCode === 'CODE_INVALID' || errCode === 'CODE_EXPIRED'
          ? 'code'
          : errCode?.startsWith('INVITE_')
            ? 'invite'
            : errCode === 'INVALID_PHONE'
              ? 'phone'
              : 'general';
      if (field === 'invite') {
        setActiveTab('signup');
      }
      showError(authErrorText(errCode), field);
    } finally {
      setVerifying(false);
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

  const lang = mobileI18n.getLanguage();
  const previewPlanLabel = invitePreview?.valid
    ? (lang === 'zh'
      ? invitePreview.planName || invitePreview.planNameEn || 'ID.Student'
      : invitePreview.planNameEn || invitePreview.planName || 'ID.Student')
    : '';
  const previewDays = invitePreview?.periodDays || 14;
  const demoNote = t('mobile.login.demoNote');

  return (
    <div style={styles.page}>
      <div style={styles.loginCard} data-testid="login-card">
        <div style={styles.brandHead}>
          <img src="/icon-192.png" alt="IDBots" style={styles.brandLogo} />
          <div>
            <h1 style={styles.brandTitle}>{t('mobile.login.title')}</h1>
            <p style={styles.brandSubtitle}>
              {t(activeTab === 'signup' ? 'mobile.login.subtitleSignup' : 'mobile.login.subtitleSignin')}
            </p>
          </div>
        </div>

        <div style={styles.segBar} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'signin'}
            data-testid="login-tab-signin"
            onClick={() => switchTab('signin')}
            style={{
              ...styles.segBtn,
              ...(activeTab === 'signin' ? styles.segBtnActive : null),
            }}
          >
            {t('mobile.login.tabSignin')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'signup'}
            data-testid="login-tab-signup"
            onClick={() => switchTab('signup')}
            style={{
              ...styles.segBtn,
              ...(activeTab === 'signup' ? styles.segBtnActive : null),
            }}
          >
            {t('mobile.login.tabSignup')}
          </button>
        </div>

        {capacityBlocked ? (
          <div style={styles.softAlert} role="status" data-testid="login-capacity-alert">
            {t('mobile.login.inviteDailyCapFull')}
          </div>
        ) : null}

        <div style={styles.fieldGroup}>
          {activeTab === 'signup' ? (
            <div>
              <div className="login-ui-field" style={styles.inputRow}>
                <input
                  id="login-invite"
                  data-testid="login-invite-input"
                  aria-label={t('mobile.login.inviteLabel')}
                  type="text"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={32}
                  value={inviteCode}
                  onChange={(event) => {
                    setInviteCode(event.target.value.toUpperCase().replace(/\s+/g, ''));
                    setCapFullAlert(false);
                    clearError();
                  }}
                  placeholder={t('mobile.login.invitePlaceholder')}
                  style={{ ...styles.bareInput, ...styles.monoInput }}
                  aria-invalid={errorField === 'invite' && Boolean(error)}
                />
                {!inviteCode.trim() ? (
                  <button
                    type="button"
                    data-testid="login-paste-invite"
                    onClick={() => {
                      void onPasteInvite();
                    }}
                    style={styles.inlineAction}
                  >
                    {t('mobile.login.pasteInvite')}
                  </button>
                ) : previewPlanLabel ? (
                  <span style={styles.inlineBadge} data-testid="login-invite-perk-badge">
                    {t('mobile.login.invitePerkBadge', { plan: previewPlanLabel, days: previewDays })}
                  </span>
                ) : null}
              </div>
              {errorField === 'invite' && error ? (
                <p style={{ ...styles.errorLeft, marginTop: 6 }} role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          ) : null}

          <div>
            <div className="login-ui-field" style={styles.inputRow}>
              <span style={styles.phonePrefix} aria-hidden="true">+86</span>
              <input
                id="login-phone"
                data-testid="login-phone-input"
                aria-label={t('mobile.login.phoneLabel')}
                type="tel"
                inputMode="numeric"
                autoComplete="tel-national"
                maxLength={11}
                value={phone}
                onChange={(event) => {
                  setPhone(event.target.value.replace(/\D/g, '').slice(0, 11));
                  clearError();
                }}
                placeholder={t('mobile.login.phonePlaceholder')}
                style={styles.bareInput}
                aria-invalid={errorField === 'phone' && Boolean(error)}
              />
            </div>
            {errorField === 'phone' && error ? (
              <p style={{ ...styles.errorLeft, marginTop: 6 }} role="alert">
                {error}
              </p>
            ) : null}
          </div>

          <div>
            <div className="login-ui-field" style={styles.inputRow}>
              <input
                id="login-code"
                data-testid="login-code-input"
                aria-label={t('mobile.login.codeLabel')}
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
                style={styles.bareInput}
                aria-invalid={errorField === 'code' && Boolean(error)}
              />
              <button
                type="button"
                data-testid="login-send-code"
                onClick={() => {
                  void onSendCode();
                }}
                disabled={sendDisabled}
                style={{
                  ...styles.inlineAction,
                  ...(sendDisabled ? styles.inlineActionDisabled : null),
                }}
              >
                {sendingCode
                  ? t('mobile.login.sendingShort')
                  : countdown > 0
                    ? t('mobile.login.countdownSec', { sec: countdown })
                    : t('mobile.login.sendCode')}
              </button>
            </div>
            {errorField === 'code' && error ? (
              <p style={{ ...styles.errorLeft, marginTop: 6 }} role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </div>

        <label style={styles.agreeLine}>
          <input
            type="checkbox"
            data-testid="login-agree-checkbox"
            checked={agreed}
            onChange={(event) => setAgreed(event.target.checked)}
            style={styles.agreeCheckbox}
          />
          <span>
            {t('mobile.login.agreePrefix')}{' '}
            <a href={mobileLegalUrl('terms')} target="_blank" rel="noreferrer" style={styles.link}>
              {t('mobile.login.termsLink')}
            </a>
            {t('mobile.login.agreeSep')}
            <a href={mobileLegalUrl('privacy')} target="_blank" rel="noreferrer" style={styles.link}>
              {t('mobile.login.privacyLink')}
            </a>
            {t('mobile.login.agreeHkSuffix')}
          </span>
        </label>

        <button
          type="button"
          data-testid="login-submit"
          onClick={() => {
            void onVerify();
          }}
          disabled={!canSubmit}
          style={{ ...styles.button, ...(!canSubmit ? styles.buttonDisabled : null) }}
        >
          {verifying
            ? t('mobile.login.verifying')
            : t(activeTab === 'signup' ? 'mobile.login.submitSignup' : 'mobile.login.verify')}
        </button>

        {errorField === 'general' && error ? (
          <p style={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        {demoNote ? <p style={styles.noteSmall}>{demoNote}</p> : null}
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
