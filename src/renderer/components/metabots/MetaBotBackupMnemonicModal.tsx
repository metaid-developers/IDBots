/**
 * MetaBot Backup Mnemonic Modal
 * Shows wallet mnemonic phrase for backup/recovery.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';

export interface MetaBotBackupMnemonicModalProps {
  metabot: Metabot;
  onClose: () => void;
}

const MetaBotBackupMnemonicModal: React.FC<MetaBotBackupMnemonicModalProps> = ({ metabot, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [mnemonic, setMnemonic] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setMnemonic('');

    window.electron.idbots
      .getMetaBotMnemonic(metabot.id)
      .then((result) => {
        if (cancelled) return;
        if (result.success && result.mnemonic?.trim()) {
          setMnemonic(result.mnemonic.trim());
          return;
        }
        setError(result.error || i18nService.t('metabotMnemonicLoadFailed'));
      })
      .catch((err: any) => {
        if (!cancelled) {
          setError(err?.message || i18nService.t('metabotMnemonicLoadFailed'));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [metabot.id]);

  const words = useMemo(
    () => (mnemonic ? mnemonic.split(/\s+/).filter(Boolean) : []),
    [mnemonic]
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 dark:bg-black/60"
        onClick={onClose}
        role="presentation"
      />
      <div className="relative w-full max-w-lg rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg shadow-xl overflow-hidden">
        <div className="px-6 py-6">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
              <ExclamationTriangleIcon className="h-5 w-5 text-amber-500" />
            </div>
            <div>
              <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('metabotBackupMnemonic')}: {metabot.name}
              </h2>
              <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
                {i18nService.t('metabotBackupMnemonicHint')}
              </p>
            </div>
          </div>

          <div className="mt-5 rounded-lg bg-claude-surface dark:bg-claude-darkSurface border dark:border-claude-darkBorder border-claude-border p-4">
            {loading ? (
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('loading')}
              </p>
            ) : error ? (
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            ) : words.length === 0 ? (
              <p className="text-sm text-red-600 dark:text-red-400">
                {i18nService.t('metabotMnemonicEmpty')}
              </p>
            ) : (
              <ol className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {words.map((word, index) => (
                  <li
                    key={`${index}-${word}`}
                    className="rounded-md border dark:border-claude-darkBorder border-claude-border px-2 py-1.5 text-sm dark:text-claude-darkText text-claude-text font-mono"
                  >
                    <span className="opacity-60 mr-1.5">{index + 1}.</span>
                    <span>{word}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="mt-6 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text hover:opacity-90"
            >
              {i18nService.t('close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MetaBotBackupMnemonicModal;

