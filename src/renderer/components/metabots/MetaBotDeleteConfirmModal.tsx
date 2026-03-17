/**
 * MetaBot Safe Delete Confirmation Modal
 * Requires mnemonic backup display and 5-second countdown before allowing delete.
 * Strictly deletes MetaBot record only; wallet and chat history are preserved.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';

export interface MetaBotDeleteConfirmModalProps {
  metabot: Metabot;
  onClose: () => void;
  onConfirm: () => void;
}

const COUNTDOWN_SECONDS = 5;

const MetaBotDeleteConfirmModal: React.FC<MetaBotDeleteConfirmModalProps> = ({
  metabot,
  onClose,
  onConfirm,
}) => {
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [mnemonicExpanded, setMnemonicExpanded] = useState(false);
  const [mnemonicLoading, setMnemonicLoading] = useState(false);
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  useEffect(() => {
    setCountdown(COUNTDOWN_SECONDS);
    countdownRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearCountdown();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearCountdown();
  }, [clearCountdown]);

  const handleShowMnemonic = async () => {
    if (mnemonic != null) {
      setMnemonicExpanded((v) => !v);
      return;
    }
    setMnemonicLoading(true);
    try {
      const result = await window.electron.idbots.getMetaBotMnemonic(metabot.id);
      if (result.success && result.mnemonic) {
        setMnemonic(result.mnemonic);
        setMnemonicExpanded(true);
      }
    } finally {
      setMnemonicLoading(false);
    }
  };

  const handleConfirm = () => {
    if (countdown > 0) return;
    onConfirm();
  };

  const canConfirm = countdown === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 dark:bg-black/60"
        onClick={onClose}
        role="presentation"
      />
      <div className="relative w-full max-w-md rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg shadow-xl overflow-hidden">
        <div className="px-6 py-6">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
              <ExclamationTriangleIcon className="h-5 w-5 text-red-500" />
            </div>
            <div>
              <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('metabotDelete')}: {metabot.name}
              </h2>
              <p className="mt-2 text-sm text-red-600 dark:text-red-400 font-medium">
                {i18nService.t('metabotDeleteWarning')}
              </p>
            </div>
          </div>

          <div className="mt-6">
            <button
              type="button"
              onClick={handleShowMnemonic}
              disabled={mnemonicLoading}
              className="text-sm text-claude-accent hover:underline disabled:opacity-50"
            >
              {mnemonicLoading
                ? i18nService.t('loading')
                : mnemonicExpanded
                  ? i18nService.t('metabotHideMnemonic')
                  : i18nService.t('metabotShowMnemonic')}
            </button>
            {mnemonicExpanded && mnemonic && (
              <div className="mt-2 p-4 rounded-lg bg-claude-surface dark:bg-claude-darkSurface border dark:border-claude-darkBorder border-claude-border">
                <p className="text-sm dark:text-claude-darkText text-claude-text font-mono break-words">
                  {mnemonic.trim().split(/\s+/).join(' ')}
                </p>
              </div>
            )}
          </div>

          <div className="mt-6 flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text hover:opacity-90"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!canConfirm}
              className="px-4 py-2 text-sm rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-gray-900 font-medium"
            >
              {canConfirm
                ? i18nService.t('metabotBackedUpConfirmDelete')
                : i18nService.t('metabotConfirmDeleteCountdown').replace('{count}', String(countdown))}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MetaBotDeleteConfirmModal;
