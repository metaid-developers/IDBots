import React from 'react';
import { i18nService } from '../../../services/i18n';

export type ChainStatus = 'pending' | 'success' | 'error';

interface ChainStatusModalProps {
  status: ChainStatus;
  title?: string;
  txids?: string[];
  error?: string;
  onClose?: () => void;
}

const ChainStatusModal: React.FC<ChainStatusModalProps> = ({ status, title, txids, error, onClose }) => {
  const t = (k: string) => i18nService.t(k);
  const heading =
    title ||
    (status === 'pending' ? (t('myAppsChainPending') || 'Writing to chain…')
      : status === 'success' ? (t('myAppsChainSuccess') || 'Published on chain')
      : (t('myAppsChainError') || 'Failed to publish'));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md mx-4 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-xl">
        <div className="p-5">
          <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">{heading}</h3>

          {status === 'pending' ? (
            <div className="mt-4 flex items-center gap-3">
              <span className="inline-block h-4 w-4 rounded-full border border-claude-accent border-t-transparent animate-spin" />
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {t('myAppsChainPendingHint') || 'Confirming on the network. This usually takes a few seconds.'}
              </p>
            </div>
          ) : null}

          {status === 'success' && txids && txids.length > 0 ? (
            <div className="mt-4 space-y-1">
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {t('myAppsTxids') || 'Transaction IDs'}
              </p>
              {txids.map((tx) => (
                <code key={tx} className="block break-all text-xs dark:text-claude-darkText text-claude-text">
                  {tx}
                </code>
              ))}
              <p className="mt-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {t('myAppsSyncDelay') || 'Indexer sync may take a moment; the list will refresh.'}
              </p>
            </div>
          ) : null}

          {status === 'error' ? (
            <p className="mt-3 text-sm text-red-500 break-words">{error || (t('myAppsChainErrorUnknown') || 'Unknown error')}</p>
          ) : null}
        </div>

        {status !== 'pending' && onClose ? (
          <div className="px-5 py-3 border-t dark:border-claude-darkBorder border-claude-border flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded-[8px] bg-claude-accent text-claude-accentInk hover:opacity-90 transition-opacity"
            >
              {t('close') || 'Close'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default ChainStatusModal;
