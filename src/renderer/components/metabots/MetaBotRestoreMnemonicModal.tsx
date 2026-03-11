/**
 * MetaBot Restore from Mnemonic Modal
 * Allows restoring a MetaBot from a 12-word mnemonic and derivation path.
 */

import React, { useMemo, useState } from 'react';
import { ExclamationTriangleIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';

export interface MetaBotRestoreMnemonicModalProps {
  onClose: () => void;
  onRestored: (metabot: Metabot) => void;
}

const DEFAULT_DERIVATION_PATH = "m/44'/10001'/0'/0/0";

const MetaBotRestoreMnemonicModal: React.FC<MetaBotRestoreMnemonicModalProps> = ({ onClose, onRestored }) => {
  const [words, setWords] = useState<string[]>(Array.from({ length: 12 }, () => ''));
  const [path, setPath] = useState(DEFAULT_DERIVATION_PATH);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'importing' | 'success'>('idle');
  const [resultMetabot, setResultMetabot] = useState<Metabot | null>(null);

  const normalizedMnemonic = useMemo(
    () => words.map((w) => w.trim().toLowerCase()).filter(Boolean).join(' '),
    [words]
  );

  const canSubmit = useMemo(() => {
    if (loading || status === 'success') return false;
    const normalizedWords = words.map((w) => w.trim()).filter(Boolean);
    return normalizedWords.length === 12 && path.trim().length > 0;
  }, [words, path, loading, status]);

  const handleWordChange = (index: number, value: string) => {
    setWords((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const handlePasteMnemonic = (value: string) => {
    const parts = value
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 12);
    if (parts.length === 0) return;
    setWords(() => Array.from({ length: 12 }, (_, i) => (parts[i] ? parts[i].toLowerCase() : '')));
  };

  const resolveErrorMessage = (raw?: string) => {
    switch (raw) {
      case 'NAME_DUPLICATE':
        return i18nService.t('metabotRestoreNameDuplicate');
      case 'NAME_EMPTY':
        return i18nService.t('metabotRestoreNameMissing');
      case 'MNEMONIC_INVALID':
        return i18nService.t('metabotRestoreMnemonicInvalid');
      case 'PATH_INVALID':
        return i18nService.t('metabotRestorePathInvalid');
      case 'CHAIN_INFO_EMPTY':
        return i18nService.t('metabotRestoreChainMissing');
      default:
        return raw || i18nService.t('metabotRestoreFailed');
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setError('');
    setLoading(true);
    setStatus('importing');
    try {
      const result = await window.electron.idbots.restoreMetaBotFromMnemonic({
        mnemonic: normalizedMnemonic,
        path: path.trim(),
      });
      if (!result.success || !result.metabot) {
        setStatus('idle');
        setError(resolveErrorMessage(result.error));
        return;
      }
      setResultMetabot(result.metabot);
      setStatus('success');
      onRestored(result.metabot);
    } catch (err) {
      setStatus('idle');
      setError(resolveErrorMessage(err instanceof Error ? err.message : undefined));
    } finally {
      setLoading(false);
    }
  };

  const handleRetry = () => {
    setError('');
    setStatus('idle');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 dark:bg-black/60"
        onClick={onClose}
        role="presentation"
      />
      <div className="relative w-full max-w-2xl rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg shadow-xl overflow-hidden">
        <div className="px-6 py-6">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
              <ExclamationTriangleIcon className="h-5 w-5 text-amber-500" />
            </div>
            <div>
              <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('metabotRestoreTitle')}
              </h2>
              <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
                {i18nService.t('metabotRestoreHint')}
              </p>
            </div>
          </div>

          {status === 'importing' && (
            <div className="mt-6 rounded-lg border dark:border-claude-darkBorder border-claude-border bg-claude-surface dark:bg-claude-darkSurface px-4 py-4">
              <div className="flex items-center gap-3">
                <ArrowPathIcon className="h-5 w-5 animate-spin text-claude-accent" />
                <div>
                  <p className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                    {i18nService.t('metabotRestoreImporting')}
                  </p>
                  <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('metabotRestoreImportingHint')}
                  </p>
                </div>
              </div>
            </div>
          )}

          {status === 'success' && (
            <div className="mt-6 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-4">
              <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
                {i18nService.t('metabotRestoreSuccess')}
              </p>
              {resultMetabot && (
                <p className="mt-1 text-xs text-emerald-700/90 dark:text-emerald-300/90">
                  {i18nService.t('metabotRestoreSuccessName').replace('{name}', resultMetabot.name)}
                </p>
              )}
            </div>
          )}

          {status !== 'success' && (
            <>
              <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 gap-3">
                {words.map((word, index) => (
                  <label key={`word-${index}`} className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {i18nService.t('metabotRestoreWord').replace('{index}', String(index + 1))}
                    <input
                      type="text"
                      value={word}
                      onChange={(e) => handleWordChange(index, e.target.value)}
                      onPaste={(e) => {
                        if (index === 0) {
                          handlePasteMnemonic(e.clipboardData.getData('text'));
                          e.preventDefault();
                        }
                      }}
                      className="mt-1 w-full rounded-lg border dark:border-claude-darkBorder border-claude-border px-3 py-2 text-sm dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent"
                      placeholder={i18nService.t('metabotRestoreWordPlaceholder')}
                    />
                  </label>
                ))}
              </div>

              <div className="mt-5">
                <label className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('metabotRestorePath')}
                </label>
                <input
                  type="text"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  className="mt-1 w-full rounded-lg border dark:border-claude-darkBorder border-claude-border px-3 py-2 text-sm dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent"
                />
              </div>
            </>
          )}

          {error && (
            <div className="mt-4 text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}

          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text hover:opacity-90"
            >
              {i18nService.t('close')}
            </button>
            {status === 'idle' && (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="px-4 py-2 text-sm rounded-xl bg-claude-accent text-white hover:bg-claude-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? i18nService.t('metabotRestoreImporting') : i18nService.t('metabotRestoreConfirm')}
              </button>
            )}
            {status === 'importing' && (
              <button
                type="button"
                disabled
                className="px-4 py-2 text-sm rounded-xl bg-claude-accent text-white opacity-60 cursor-not-allowed"
              >
                {i18nService.t('metabotRestoreImporting')}
              </button>
            )}
            {status === 'success' && (
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm rounded-xl bg-emerald-600 text-white hover:bg-emerald-700"
              >
                {i18nService.t('metabotRestoreClose')}
              </button>
            )}
            {status === 'idle' && error && (
              <button
                type="button"
                onClick={handleRetry}
                className="px-4 py-2 text-sm rounded-xl border border-amber-400 text-amber-700 dark:text-amber-300 hover:bg-amber-50/40 dark:hover:bg-amber-500/10"
              >
                {i18nService.t('metabotRestoreRetry')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MetaBotRestoreMnemonicModal;
