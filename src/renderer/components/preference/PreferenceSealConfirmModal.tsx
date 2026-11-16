import React from 'react';
import { LockClosedIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

interface PreferenceSealConfirmModalProps {
  pairCount: number;
  commitCloseAt: number;
  revealCloseAt: number;
  sealing: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

const formatAt = (sec: number): string => new Date(sec * 1000).toLocaleString();

const PreferenceSealConfirmModal: React.FC<PreferenceSealConfirmModalProps> = ({
  pairCount,
  commitCloseAt,
  revealCloseAt,
  sealing,
  error,
  onConfirm,
  onCancel,
}) => (
  <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={sealing ? undefined : onCancel}>
    <div className="absolute inset-0 bg-black/50" />
    <div
      role="dialog"
      aria-modal="true"
      className="relative w-[26rem] rounded-xl border border-[var(--border-color)] bg-[var(--bg-panel)] p-5 text-[var(--text-primary)] shadow-2xl"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex flex-col items-center text-center">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-[var(--color-accent)]">
          <LockClosedIcon className="h-5 w-5 text-[var(--color-accent)]" />
        </div>
        <h3 className="mb-2 text-sm font-semibold">{i18nService.t('preference.confirm.title')}</h3>
        <p className="mb-4 text-sm text-[var(--text-secondary)]">
          {i18nService
            .t('preference.confirm.body')
            .replace('{count}', String(pairCount))
            .replace('{commit}', formatAt(commitCloseAt))
            .replace('{reveal}', formatAt(revealCloseAt))}
        </p>
        {error && (
          <p className="mb-3 w-full rounded-lg border border-red-500/40 px-3 py-2 text-left text-xs text-red-500">
            {i18nService.t('preference.error.generic').replace('{error}', error)}
          </p>
        )}
        <div className="flex w-full gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={sealing}
            className="flex-1 rounded-[8px] border border-[var(--border-color)] px-3 py-2 text-sm hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            {i18nService.t('preference.confirm.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={sealing}
            className="border border-[var(--btn-primary-edge)] bg-claude-accent text-claude-accentInk hover:brightness-[0.96] active:brightness-[0.9] transition-[filter] flex-1 rounded-[8px] px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            {sealing ? i18nService.t('preference.confirm.sealing') : i18nService.t('preference.confirm.confirm')}
          </button>
        </div>
      </div>
    </div>
  </div>
);

export default PreferenceSealConfirmModal;
