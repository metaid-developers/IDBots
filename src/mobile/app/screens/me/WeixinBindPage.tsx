import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { t } from '../../../i18n';
import { useMetabots } from '../../hooks/useMetabots';
import { resolveTwinMetabotId } from '../../activity';
import { SecondaryPageShell } from './SecondaryPageShell';

/**
 * WeChat bot binding (Me → WeChat Bot): drives the weixin iLink QR
 * authorization over the C2 gateway (`im:weixin:*` are allowlist tier P2, so
 * no contract change). The main process owns the login lifecycle — on scan
 * confirm it writes the credential file, enables the channel and starts the
 * gateway (imGatewayManager.startWeixinLogin) — so this page only renders the
 * QR, polls `im:status:get` until the channel connects, and pins the route
 * metabot to the tenant's Twin bot beforehand.
 *
 * Feature detection: the mock bridge does not implement the `im` facade, so
 * the page degrades to a "not available" note instead of throwing (mock dev
 * mode, SSR tests).
 */

/** The slice of WeixinGatewayStatus the page reacts to (structural for tests). */
export interface WeixinPollInput {
  loginState: 'idle' | 'wait' | 'scanned';
  loginPending: boolean;
  connected: boolean;
}

export type WeixinPollVerdict = 'connected' | 'scanned' | 'waiting' | 'expired';

/**
 * One poll tick during an active binding. The status never reports
 * expired/error directly: the background login ends and `loginPending`
 * flips back to false, which reads as "the QR died" (imGatewayManager
 * clears pendingQr on every terminal state).
 */
export function classifyWeixinPoll(input: WeixinPollInput, hasCredentials: boolean | null): WeixinPollVerdict {
  if (input.connected) return 'connected';
  if (hasCredentials) return 'connected';
  if (input.loginState === 'scanned') return 'scanned';
  if (input.loginPending) return 'waiting';
  return 'expired';
}

type ImFacade = Window['electron']['im'];

/** The `im` facade only exists on the real gateway shim; absent on the mock. */
function resolveImFacade(): ImFacade | null {
  const facade = (globalThis as { electron?: Window['electron'] }).electron?.im;
  return facade && typeof facade.weixinLoginStart === 'function' ? facade : null;
}

const POLL_INTERVAL_MS = 2_000;
/** Wall-clock cap for one binding attempt; the QR itself expires earlier. */
const BINDING_TIMEOUT_MS = 6 * 60_000;

type Phase = 'loading' | 'ready' | 'binding' | 'connected' | 'failed';

interface ReadyState {
  connected: boolean;
  hasCredentials: boolean;
}

export function WeixinBindPage(props: { onBack: () => void }): JSX.Element {
  // Render-time feature detection: the mock bridge (and SSR) has no `im`
  // facade, so the page pins the unavailable shell without waiting for
  // effects to run (repo test stack is SSR-only).
  const imAvailable = resolveImFacade() !== null;
  const [phase, setPhase] = useState<Phase>('loading');
  const [ready, setReady] = useState<ReadyState>({ connected: false, hasCredentials: false });
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);
  const [failureKey, setFailureKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const bindingStartedAt = useRef(0);
  /** True while a QR login is alive; unmount aborts it (harmless post-confirm). */
  const isBindingRef = useRef(false);
  const { bots } = useMetabots();
  const twinMetabotId = resolveTwinMetabotId(bots);

  const clearPoll = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const refreshReadyState = useCallback(async () => {
    const im = resolveImFacade();
    if (!im) return;
    const [statusResult, credentialResult] = await Promise.all([
      im.getStatus().catch(() => null),
      im.weixinCheckCredentials().catch(() => null),
    ]);
    setReady({
      connected: statusResult?.success && statusResult.status
        ? Boolean(statusResult.status.weixin?.connected)
        : false,
      hasCredentials: Boolean(credentialResult?.success && credentialResult.hasCredentials),
    });
  }, []);

  // Initial load: read the current bound state (feature detection already
  // happened at render time). Alignment of the route metabot happens
  // separately below, once the metabot list arrives.
  useEffect(() => {
    if (!imAvailable) return;
    let cancelled = false;
    void refreshReadyState().then(() => {
      if (!cancelled) setPhase('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [imAvailable, refreshReadyState]);

  // Pin the route metabot to the Twin bot BEFORE any bind: the first inbound
  // message after the scan confirm reads config.weixin.metabotId, so setting
  // it now avoids a window where a null-metabot session could be created.
  useEffect(() => {
    const im = resolveImFacade();
    if (!im || !imAvailable || twinMetabotId === null) return;
    let cancelled = false;
    void im.getConfig().then(async (result) => {
      if (cancelled || !result.success || !result.config?.weixin) return;
      if (result.config.weixin.metabotId === twinMetabotId) return;
      // Full object: the facade types weixin as non-partial; the main-process
      // store merges it as a patch either way.
      await im.setConfig({ weixin: { ...result.config.weixin, metabotId: twinMetabotId } }).catch(() => null);
    });
    return () => {
      cancelled = true;
    };
  }, [imAvailable, twinMetabotId]);

  const stopPolling = useCallback((verdict: 'connected' | 'expired') => {
    isBindingRef.current = false;
    clearPoll();
    if (verdict === 'connected') {
      void refreshReadyState();
      setPhase('connected');
    } else {
      setFailureKey('mobile.me.weixin.expired');
      setPhase('failed');
    }
  }, [clearPoll, refreshReadyState]);

  const startPolling = useCallback(() => {
    clearPoll();
    bindingStartedAt.current = Date.now();
    pollTimer.current = setInterval(() => {
      const im = resolveImFacade();
      if (!im) return;
      void Promise.all([
        im.getStatus().catch(() => null),
        im.weixinCheckCredentials().catch(() => null),
      ]).then(([statusResult, credentialResult]) => {
        if (!pollTimer.current) return; // already settled via stopPolling
        const weixin = statusResult?.success ? statusResult.status?.weixin : null;
        const hasCredentials = credentialResult?.success && credentialResult.hasCredentials
          ? true
          : false;
        const verdict = classifyWeixinPoll(
          {
            loginState: weixin?.loginState ?? 'idle',
            loginPending: Boolean(weixin?.loginPending),
            connected: Boolean(weixin?.connected),
          },
          hasCredentials ? true : null,
        );
        if (verdict === 'scanned') setScanned(true);
        if (verdict === 'connected' || verdict === 'expired') stopPolling(verdict);
        if (Date.now() - bindingStartedAt.current > BINDING_TIMEOUT_MS) stopPolling('expired');
      });
    }, POLL_INTERVAL_MS);
  }, [clearPoll, stopPolling]);

  useEffect(() => clearPoll, [clearPoll]);

  // Leaving mid-binding politely aborts the pending QR (a no-op once confirmed).
  useEffect(() => () => {
    if (!isBindingRef.current) return;
    void resolveImFacade()?.weixinLoginCancel().catch(() => undefined);
  }, []);

  const startBinding = useCallback(async () => {
    const im = resolveImFacade();
    if (!im) return;
    setActionError(false);
    setFailureKey(null);
    setScanned(false);
    setQrDataUrl(null);
    try {
      const result = await im.weixinLoginStart();
      if (!result.success || !result.content) {
        setFailureKey('mobile.me.weixin.failed');
        setPhase('failed');
        return;
      }
      const dataUrl = await QRCode.toDataURL(result.content, { width: 320, margin: 1 });
      setQrDataUrl(dataUrl);
      setPhase('binding');
      isBindingRef.current = true;
      startPolling();
    } catch {
      setFailureKey('mobile.me.weixin.failed');
      setPhase('failed');
    }
  }, [startPolling]);

  const retryBinding = useCallback(async () => {
    const im = resolveImFacade();
    if (im) await im.weixinLoginCancel().catch(() => undefined);
    await startBinding();
  }, [startBinding]);

  const stopBot = useCallback(async () => {
    const im = resolveImFacade();
    if (!im) return;
    setActionError(false);
    const result = await im.stopGateway('weixin').catch(() => null);
    if (!result?.success) {
      setActionError(true);
      return;
    }
    await refreshReadyState();
    setPhase('ready');
  }, [refreshReadyState]);

  const statusLabel = ready.connected
    ? t('mobile.me.weixin.statusConnected')
    : t('mobile.me.weixin.statusDisconnected');

  if (!imAvailable) {
    return (
      <SecondaryPageShell title={t('mobile.me.entry.weixinBind')} onBack={props.onBack} testId="me-page-weixin-bind">
        <div className="twin-panel twin-panel-padded">
          <p className="text-sm text-[var(--text-secondary)]" data-testid="weixin-bind-unavailable">
            {t('mobile.me.weixin.notAvailable')}
          </p>
        </div>
      </SecondaryPageShell>
    );
  }

  return (
    <SecondaryPageShell title={t('mobile.me.entry.weixinBind')} onBack={props.onBack} testId="me-page-weixin-bind">
      <div className="twin-panel twin-panel-padded">
        <div className="flex items-center justify-between">
          <p className="twin-list-title">{t('mobile.me.entry.weixinBind')}</p>
          <span
            className="twin-list-value"
            data-testid="weixin-bind-status"
            data-state={ready.connected ? 'connected' : 'disconnected'}
          >
            {statusLabel}
          </span>
        </div>
        <p className="twin-help mt-1">{t('mobile.me.weixin.twinNote')}</p>
        {twinMetabotId === null ? (
          <p className="twin-help mt-1 text-[var(--twin-warning)]" data-testid="weixin-bind-twin-missing">
            {t('mobile.me.weixin.twinMissing')}
          </p>
        ) : null}
        {actionError ? (
          <p className="twin-help mt-1 text-red-600" data-testid="weixin-bind-action-error">
            {t('mobile.me.weixin.stopFailed')}
          </p>
        ) : null}
      </div>

      {phase === 'loading' ? (
        <div className="twin-panel twin-panel-padded">
          <p className="text-sm text-[var(--text-secondary)]">{t('mobile.common.loading')}</p>
        </div>
      ) : null}

      {phase === 'ready' || phase === 'failed' ? (
        <div className="twin-panel twin-panel-padded">
          {phase === 'failed' && failureKey ? (
            <p className="mb-2 text-sm text-red-600" data-testid="weixin-bind-error">
              {t(failureKey)}
            </p>
          ) : null}
          <button
            type="button"
            data-testid="weixin-bind-start"
            onClick={() => void (phase === 'failed' ? retryBinding() : startBinding())}
            className="twin-button twin-button-primary w-full"
          >
            {t('mobile.me.weixin.bindNow')}
          </button>
          {ready.hasCredentials && !ready.connected ? (
            <p className="twin-help mt-2">{t('mobile.me.weixin.sessionExpiredNote')}</p>
          ) : null}
          {phase === 'failed' ? (
            <button
              type="button"
              data-testid="weixin-bind-cancel"
              onClick={() => {
                setFailureKey(null);
                setPhase('ready');
              }}
              className="twin-button twin-button-secondary mt-2 w-full"
            >
              {t('mobile.common.cancel')}
            </button>
          ) : null}
        </div>
      ) : null}

      {phase === 'binding' ? (
        <div className="twin-panel twin-panel-padded flex flex-col items-center gap-3">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={t('mobile.me.weixin.qrAlt')}
              data-testid="weixin-bind-qr"
              className="h-64 w-64 rounded-xl border border-[var(--border-color)]"
            />
          ) : (
            <p className="text-sm text-[var(--text-secondary)]">{t('mobile.me.weixin.qrFailed')}</p>
          )}
          <p className="text-sm text-[var(--text-secondary)]" data-testid={scanned ? 'weixin-bind-scanned' : 'weixin-bind-waiting'}>
            {scanned ? t('mobile.me.weixin.scanned') : t('mobile.me.weixin.binding')}
          </p>
          <p className="twin-help text-center">{t('mobile.me.weixin.scanPrompt')}</p>
        </div>
      ) : null}

      {phase === 'connected' ? (
        <div className="twin-panel twin-panel-padded">
          <p className="text-sm" data-testid="weixin-bind-done">
            {t('mobile.me.weixin.connectedDone')}
          </p>
          <button
            type="button"
            data-testid="weixin-bind-stop"
            onClick={() => void stopBot()}
            className="twin-button twin-button-secondary mt-3 w-full"
          >
            {t('mobile.me.weixin.stop')}
          </button>
        </div>
      ) : null}
    </SecondaryPageShell>
  );
}
