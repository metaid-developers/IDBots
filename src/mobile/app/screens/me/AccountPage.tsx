import { useState } from 'react';
import { t } from '../../../i18n';
import { logout, requestAccountDeletion } from '../../../login/loginApi';
import { BottomSheet } from '../../components/BottomSheet';
import { SecondaryPageShell } from './SecondaryPageShell';

/**
 * account secondary page (IA-PLAN v1 §4.9): logout + account deletion only.
 * Deliberately NO mnemonic/import/chain-backup entries (IA-PLAN §3.1:
 * mobile is a thin tenant client; scope OUT for this cycle).
 */
export function AccountPage(props: { onBack: () => void }): JSX.Element {
  const [sheet, setSheet] = useState<'logout' | 'delete' | null>(null);
  const [reason, setReason] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const doLogout = async () => {
    setBusy(true);
    try {
      await logout();
      window.location.assign('/login');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await requestAccountDeletion(reason.trim() || undefined);
      setDone(true);
      setTimeout(() => window.location.assign('/login'), 1200);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SecondaryPageShell title={t('mobile.me.entry.account')} onBack={props.onBack} testId="me-page-account">
      <div className="twin-panel twin-panel-padded">
        <button
          type="button"
          data-testid="account-logout"
          onClick={() => setSheet('logout')}
          className="twin-list-row"
        >
          {t('mobile.me.logout')}
        </button>
        <button
          type="button"
          data-testid="account-delete"
          onClick={() => {
            setDone(false);
            setReason('');
            setConfirmText('');
            setSheet('delete');
          }}
          className="twin-list-row text-[var(--twin-danger)]"
        >
          {t('mobile.me.deleteAccount')}
        </button>
      </div>

      {sheet === 'logout' ? (
        <BottomSheet title={t('mobile.me.logoutTitle')} onClose={() => setSheet(null)}>
          <p className="mb-4 text-sm text-[var(--text-secondary)]">{t('mobile.me.logoutBody')}</p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setSheet(null)}
              className="twin-button twin-button-secondary flex-1"
            >
              {t('mobile.me.botCancel')}
            </button>
            <button
              type="button"
              onClick={() => void doLogout()}
              disabled={busy}
              className="twin-button twin-button-primary flex-1"
            >
              {t('mobile.me.logoutConfirm')}
            </button>
          </div>
        </BottomSheet>
      ) : null}
      {sheet === 'delete' ? (
        <BottomSheet title={t('mobile.me.deleteTitle')} onClose={() => setSheet(null)}>
          <AccountDeleteSheet
            busy={busy}
            done={done}
            reason={reason}
            confirmText={confirmText}
            onReasonChange={setReason}
            onConfirmTextChange={setConfirmText}
            onCancel={() => setSheet(null)}
            onConfirm={() => void doDelete()}
          />
        </BottomSheet>
      ) : null}
    </SecondaryPageShell>
  );
}

/**
 * Presentational body of the delete-account confirmation sheet, factored out
 * so the SSR-only test stack can pin both states of the typed-confirmation
 * gate (repo has no jsdom; see tests/mobileMeIa.test.tsx).
 *
 * Gate: the confirm button stays disabled until the typed text equals the
 * prompt-shown phrase exactly (zh word for delete, en "DELETE"). The reason
 * field and the deletion request call sequence are unchanged — the gate only
 * delays the button, never alters what is submitted.
 */
export function AccountDeleteSheet(props: {
  busy: boolean;
  done: boolean;
  reason: string;
  confirmText: string;
  onReasonChange: (value: string) => void;
  onConfirmTextChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const phrase = t('mobile.me.deleteConfirmPhrase');
  // Empty phrase (missing copy) must fail CLOSED, never silently unlock.
  const gateSatisfied = phrase.length > 0 && props.confirmText === phrase;

  if (props.done) {
    return (
      <p className="min-h-[44px] py-3 text-center text-sm font-medium text-emerald-600">
        {t('mobile.me.deleteDone')}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-[var(--text-secondary)]">{t('mobile.me.deleteBody')}</p>
      <div>
        <p
          data-testid="account-delete-confirm-prompt"
          className="mb-2 text-sm font-medium text-[var(--text-primary)]"
        >
          {t('mobile.me.deleteConfirmPrompt', { phrase })}
        </p>
        <input
          value={props.confirmText}
          onChange={(event) => props.onConfirmTextChange(event.target.value)}
          placeholder={phrase}
          data-testid="account-delete-confirm-input"
          data-confirm-phrase={phrase}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="twin-input"
        />
      </div>
      <input
        value={props.reason}
        onChange={(event) => props.onReasonChange(event.target.value)}
        placeholder={t('mobile.me.deleteReasonPlaceholder')}
        className="twin-input"
      />
      <div className="flex gap-3">
        <button
          type="button"
          onClick={props.onCancel}
          className="twin-button twin-button-secondary flex-1"
        >
          {t('mobile.me.botCancel')}
        </button>
        <button
          type="button"
          data-testid="account-delete-confirm"
          onClick={props.onConfirm}
          disabled={props.busy || !gateSatisfied}
          className="twin-button twin-button-danger flex-1"
        >
          {t('mobile.me.deleteConfirm')}
        </button>
      </div>
    </div>
  );
}
