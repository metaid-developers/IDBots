import { useEffect, useRef, useState } from 'react';
import { ClipboardDocumentIcon } from '@heroicons/react/24/outline';
import { t } from '../../../i18n';
import type { MobileUserIdentity } from '../../hooks/useIdentity';
import { getMobileElectron } from '../../appBridge';
import { formatDateTime } from '../../format';
import { BotAvatar } from '../../components/BotAvatar';
import { SecondaryPageShell } from './SecondaryPageShell';

const inputClass =
  'min-h-[44px] w-full rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2.5 text-[15px] text-[var(--text-primary)] outline-none';

/**
 * profile secondary page (IA-PLAN v1 §4.3): explicit-save name editing,
 * read-only identity card with copy actions, and the sync status area whose
 * retry buttons only appear in an abnormal state.
 *
 * Avatar editing is display-only this cycle (IA-PLAN §5 gap 1: the IPC
 * contract has no `userIdentity.updateAvatar` channel; a contract change
 * request is required before this can be built).
 */
export function ProfilePage(props: {
  identity: MobileUserIdentity | null;
  onBack: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Called after a successful name save so the Me screen re-pulls identity. */
  onNameSaved?: () => Promise<void> | void;
}): JSX.Element {
  const initialName = props.identity?.name ?? '';
  const [name, setName] = useState(initialName);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [retryState, setRetryState] = useState<'idle' | 'sync' | 'subsidy'>('idle');
  const [retryFeedback, setRetryFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dirty = name !== initialName && name.trim().length > 0;

  useEffect(() => {
    props.onDirtyChange?.(dirty);
    return () => props.onDirtyChange?.(false);
  }, [dirty]);

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  const copyValue = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      // Clipboard unavailable (e.g. insecure context): no false "copied" claim.
    }
  };

  const save = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    setSaved(false);
    setSaveError(null);
    try {
      const result = await getMobileElectron().userIdentity.updateName({ name: name.trim() });
      if (!result?.success) throw new Error(result?.error || 'updateName rejected');
      await props.onNameSaved?.();
      props.onDirtyChange?.(false);
      setSaved(true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t('mobile.me.settingsSaveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const runRetry = async (kind: 'sync' | 'subsidy') => {
    setRetryState(kind);
    setRetryFeedback(null);
    try {
      const bridge = getMobileElectron().userIdentity;
      const result = kind === 'sync' ? await bridge.retryChainSync() : await bridge.retrySubsidy();
      if (!result?.success) throw new Error(result?.error || 'retry rejected');
      setRetryFeedback({ ok: true, message: t('mobile.me.profile.retryOk') });
    } catch (error) {
      setRetryFeedback({
        ok: false,
        message: `${t('mobile.me.profile.retryFailed')}${error instanceof Error ? `: ${error.message}` : ''}`,
      });
    } finally {
      setRetryState('idle');
    }
  };

  const syncAbnormal = Boolean(
    props.identity && (props.identity.sync_state !== 'synced' || props.identity.sync_error),
  );

  const identityRows: Array<{ key: string; label: string; value: string }> = props.identity
    ? [
        { key: 'metaid', label: t('mobile.me.profile.metaidLabel'), value: props.identity.globalmetaid || props.identity.metaid },
        { key: 'address', label: t('mobile.me.profile.addressLabel'), value: props.identity.mvc_address },
        { key: 'createdAt', label: t('mobile.me.profile.createdAtLabel'), value: formatDateTime(props.identity.created_at) },
      ]
    : [];

  return (
    <SecondaryPageShell title={t('mobile.me.entry.profile')} onBack={props.onBack} testId="me-page-profile">
      {/* Avatar area: display-only this cycle (contract gap, IA-PLAN §5.1). */}
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-4">
        <BotAvatar name={props.identity?.name} avatar={props.identity?.avatar} size={80} testId="profile-avatar" />
        <button
          type="button"
          disabled
          className="min-h-[44px] px-2 text-sm text-[var(--text-secondary)]"
          title={t('mobile.me.profile.avatarComingSoon')}
        >
          {t('mobile.me.profile.changeAvatar')}
        </button>
        <p className="text-xs text-[var(--text-secondary)]">{t('mobile.me.profile.avatarComingSoon')}</p>
      </div>

      {/* Name: explicit save, dirty-gated (IA-PLAN §2.5 rule 1). */}
      <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-4">
        <label htmlFor="profile-name" className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
          {t('mobile.me.profile.nameLabel')}
        </label>
        <input
          id="profile-name"
          data-testid="profile-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
            setSaveError(null);
          }}
          placeholder={t('mobile.me.profile.namePlaceholder')}
          className={inputClass}
        />
        {saved ? (
          <p aria-live="polite" data-testid="profile-saved" className="mt-2 text-xs text-emerald-600">
            {t('mobile.me.settingsSaved')}
          </p>
        ) : null}
        {saveError ? (
          <p aria-live="polite" data-testid="profile-save-error" className="mt-2 break-words text-xs text-red-600">
            {saveError}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || busy}
          data-testid="profile-save"
          className="mt-3 min-h-[44px] w-full rounded-xl bg-[var(--color-primary)] py-2 text-sm font-medium text-black active:opacity-80 disabled:opacity-40"
        >
          {t('mobile.me.profile.save')}
        </button>
      </div>

      {/* Identity read-only card. */}
      <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-4">
        <p className="mb-2 text-xs font-medium text-[var(--text-secondary)]">{t('mobile.me.profile.identityTitle')}</p>
        {identityRows.map((row) => (
          <div
            key={row.key}
            className="flex min-h-[44px] items-center justify-between gap-3 border-b border-[var(--border-color)] py-2 last:border-b-0"
          >
            <div className="min-w-0">
              <p className="text-xs text-[var(--text-secondary)]">{row.label}</p>
              <p className="break-all text-sm text-[var(--text-primary)]">{row.value}</p>
            </div>
            {row.key !== 'createdAt' ? (
              <div className="flex shrink-0 items-center gap-1">
                {copiedKey === row.key ? (
                  <span aria-live="polite" className="text-xs text-emerald-600">{t('mobile.me.profile.copied')}</span>
                ) : null}
                <button
                  type="button"
                  aria-label={t('mobile.me.profile.copy')}
                  data-testid={`profile-copy-${row.key}`}
                  onClick={() => void copyValue(row.key, row.value)}
                  className="flex h-11 w-11 items-center justify-center text-[var(--text-secondary)] active:text-[var(--text-primary)]"
                >
                  <ClipboardDocumentIcon className="h-5 w-5" aria-hidden />
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {/* Sync status area: retries only render in an abnormal state. */}
      <div className="rounded-2xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-4" data-testid="profile-sync-area" data-sync-ok={syncAbnormal ? 'no' : 'yes'}>
        <p className="mb-2 text-xs font-medium text-[var(--text-secondary)]">{t('mobile.me.profile.syncTitle')}</p>
        {syncAbnormal ? (
          <>
            <p className="text-sm font-medium text-red-600">{t('mobile.me.profile.syncError')}</p>
            {props.identity?.sync_error ? (
              <p className="mt-1 break-words text-xs text-[var(--text-secondary)]">{props.identity.sync_error}</p>
            ) : null}
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                data-testid="profile-retry-sync"
                disabled={retryState !== 'idle'}
                onClick={() => void runRetry('sync')}
                className="min-h-[44px] flex-1 rounded-xl border border-[var(--border-color)] py-2 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)] disabled:opacity-40"
              >
                {retryState === 'sync' ? t('mobile.me.profile.retryBusy') : t('mobile.me.profile.retrySync')}
              </button>
              <button
                type="button"
                data-testid="profile-retry-subsidy"
                disabled={retryState !== 'idle'}
                onClick={() => void runRetry('subsidy')}
                className="min-h-[44px] flex-1 rounded-xl border border-[var(--border-color)] py-2 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)] disabled:opacity-40"
              >
                {retryState === 'subsidy' ? t('mobile.me.profile.retryBusy') : t('mobile.me.profile.retrySubsidy')}
              </button>
            </div>
            {retryFeedback ? (
              <p aria-live="polite" className={`mt-2 break-words text-xs ${retryFeedback.ok ? 'text-emerald-600' : 'text-red-600'}`}>
                {retryFeedback.message}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-emerald-600">{t('mobile.me.profile.syncOk')}</p>
        )}
      </div>
    </SecondaryPageShell>
  );
}
