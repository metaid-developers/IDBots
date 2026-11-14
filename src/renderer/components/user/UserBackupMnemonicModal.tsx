/**
 * User Backup Mnemonic Modal
 * Reveals the local user identity mnemonic from the profile page so it can
 * be backed up again after creation. Escape or backdrop click closes it.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { ClipboardDocumentIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import MnemonicWordGrid from './MnemonicWordGrid';

export interface UserBackupMnemonicModalProps {
  onClose: () => void;
}

const UserBackupMnemonicModal: React.FC<UserBackupMnemonicModalProps> = ({ onClose }) => {
  const [loading, setLoading] = useState(true);
  const [mnemonic, setMnemonic] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setMnemonic('');

    window.electron.userIdentity
      .revealMnemonic()
      .then((result) => {
        if (cancelled) return;
        if (result.success && result.mnemonic?.trim()) {
          setMnemonic(result.mnemonic.trim());
          return;
        }
        setError(result.error || i18nService.t('userSettingsRevealFailed'));
      })
      .catch((err: any) => {
        if (!cancelled) {
          setError(err?.message || i18nService.t('userSettingsRevealFailed'));
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
  }, []);

  // Close with Escape
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const words = useMemo(
    () => (mnemonic ? mnemonic.split(/\s+/).filter(Boolean) : []),
    [mnemonic]
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(words.join(' '));
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('userSettingsCopied') }));
    } catch {
      // ignore clipboard failures
    }
  };

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
                {i18nService.t('userSettingsBackupMnemonicTitle')}
              </h2>
              <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
                {i18nService.t('userSettingsBackupMnemonicWarning')}
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
                {i18nService.t('userSettingsRevealFailed')}
              </p>
            ) : (
              <MnemonicWordGrid words={words} />
            )}
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => { void handleCopy(); }}
              disabled={loading || words.length === 0}
              className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ClipboardDocumentIcon className="h-3.5 w-3.5 mr-1.5" />
              {i18nService.t('copy')}
            </button>
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

export default UserBackupMnemonicModal;
