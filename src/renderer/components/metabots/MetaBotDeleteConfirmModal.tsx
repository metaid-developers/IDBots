/**
 * MetaBot Delete Confirmation Modal (S1 — Studio Linear)
 *
 * Shows a crisp rose danger warning, an expandable mnemonic recovery check so
 * users can verify/copy their 12 words before deletion, and a 5-second safety
 * countdown on the destructive confirm action.
 */

import React, { useEffect, useState } from 'react';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  DocumentDuplicateIcon,
  ExclamationTriangleIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';
import {
  METABOT_BTN_FLAT_CLASS,
  METABOT_ICON_BTN_CLASS,
  METABOT_MODAL_BACKDROP_CLASS,
  METABOT_MODAL_FOOTER_CLASS,
  METABOT_MODAL_HEADER_CLASS,
  METABOT_MODAL_SCRIM_CLASS,
  METABOT_MODAL_SHELL_CLASS,
} from './metaBotCardPresentation.js';

export interface MetaBotDeleteConfirmModalProps {
  metabot: Metabot;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
}

const COUNTDOWN_SECONDS = 5;

const MetaBotDeleteConfirmModal: React.FC<MetaBotDeleteConfirmModalProps> = ({
  metabot,
  onClose,
  onConfirm,
}) => {
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [deleting, setDeleting] = useState(false);
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [mnemonic, setMnemonic] = useState('');
  const [mnemonicLoading, setMnemonicLoading] = useState(false);
  const [mnemonicError, setMnemonicError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCountdown(COUNTDOWN_SECONDS);
    const timer = window.setInterval(() => {
      setCountdown((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [metabot.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !deleting) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleting, onClose]);

  const handleToggleMnemonic = async () => {
    const next = !showMnemonic;
    setShowMnemonic(next);
    if (!next || mnemonic || mnemonicLoading) return;
    setMnemonicLoading(true);
    setMnemonicError('');
    try {
      const res = await window.electron.idbots.getMetaBotMnemonic(metabot.id);
      if (!res.success || !res.mnemonic) {
        setMnemonicError(res.error || i18nService.t('metabotBackupMnemonicLoadFailed'));
        return;
      }
      setMnemonic(res.mnemonic);
    } catch (err) {
      setMnemonicError(err instanceof Error ? err.message : i18nService.t('metabotBackupMnemonicLoadFailed'));
    } finally {
      setMnemonicLoading(false);
    }
  };

  const handleCopyMnemonic = () => {
    if (!mnemonic) return;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(mnemonic).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
        window.dispatchEvent(
          new CustomEvent('app:showToast', { detail: i18nService.t('metabotBackupMnemonicCopied') }),
        );
      });
    }
  };

  const handleConfirm = async () => {
    if (countdown > 0 || deleting) return;
    setDeleting(true);
    try {
      await onConfirm();
    } finally {
      setDeleting(false);
    }
  };

  const words = mnemonic.trim().split(/\s+/).filter(Boolean);

  return (
    <div className={METABOT_MODAL_BACKDROP_CLASS} data-slot="metabot-delete-confirm-modal">
      <div
        className={METABOT_MODAL_SCRIM_CLASS}
        onClick={deleting ? undefined : onClose}
        aria-hidden
      />
      <div
        className={`${METABOT_MODAL_SHELL_CLASS} w-full max-w-[480px]`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={i18nService.t('metabotDeleteConfirmTitle')}
      >
        {/* Header */}
        <div className={METABOT_MODAL_HEADER_CLASS}>
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-rose-500/30 bg-rose-500/10 text-red-600 dark:text-rose-400">
              <TrashIcon className="h-4 w-4" aria-hidden />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[14px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                {i18nService.t('metabotDeleteConfirmTitle')}
              </div>
              <div className="truncate text-[11.5px] text-[#5a6577] dark:text-[#94a3b8]">
                {metabot.name}
              </div>
            </div>
          </div>
          <button
            type="button"
            disabled={deleting}
            onClick={onClose}
            className={METABOT_ICON_BTN_CLASS}
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3.5">
          <div className="flex items-start gap-2.5 rounded-[9px] border border-rose-500/35 bg-rose-500/[0.08] px-3.5 py-3 text-[12.5px] leading-relaxed text-red-700 dark:text-rose-300">
            <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-rose-400" aria-hidden />
            <span>{i18nService.t('metabotDeleteConfirmWarning')}</span>
          </div>

          {/* Expandable Mnemonic Backup Check */}
          <div className="overflow-hidden rounded-[9px] border border-slate-900/[0.09] dark:border-white/[0.09] bg-[#f8fafc] dark:bg-[#101826]">
            <button
              type="button"
              onClick={() => void handleToggleMnemonic()}
              className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-[12.5px] font-semibold text-[#181d25] dark:text-[#f3f5f8] hover:bg-[#eef1f5] dark:hover:bg-white/[0.04] transition-colors"
            >
              <span>{i18nService.t('metabotBackupMnemonic')}</span>
              {showMnemonic ? (
                <ChevronUpIcon className="h-4 w-4 text-[#5a6577] dark:text-[#94a3b8]" />
              ) : (
                <ChevronDownIcon className="h-4 w-4 text-[#5a6577] dark:text-[#94a3b8]" />
              )}
            </button>

            {showMnemonic && (
              <div className="border-t border-slate-900/[0.08] dark:border-white/[0.08] px-3.5 py-3 space-y-2.5">
                {mnemonicLoading ? (
                  <p className="text-[12px] text-[#5a6577] dark:text-[#94a3b8]">
                    {i18nService.t('metabotBackupMnemonicLoading')}
                  </p>
                ) : mnemonicError ? (
                  <p className="text-[12px] text-red-600 dark:text-rose-400">{mnemonicError}</p>
                ) : (
                  <>
                    <div className="grid grid-cols-3 gap-1.5">
                      {words.map((word, idx) => (
                        <div
                          key={`${idx}-${word}`}
                          className="flex items-center gap-1.5 rounded-[6px] border border-slate-900/[0.08] dark:border-white/[0.08] bg-white dark:bg-[#141e2e] px-2 py-1.5 font-mono text-[11.5px]"
                        >
                          <span className="text-[10px] font-bold tabular-nums text-[#8c96a6]">
                            {String(idx + 1).padStart(2, '0')}
                          </span>
                          <span className="truncate font-semibold text-[#181d25] dark:text-[#f3f5f8]">
                            {word}
                          </span>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={handleCopyMnemonic}
                      className={METABOT_BTN_FLAT_CLASS}
                    >
                      {copied ? (
                        <CheckIcon className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <DocumentDuplicateIcon className="h-3.5 w-3.5" />
                      )}
                      <span>
                        {copied
                          ? i18nService.t('metabotBackupMnemonicCopied')
                          : i18nService.t('metabotBackupMnemonicCopy')}
                      </span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className={METABOT_MODAL_FOOTER_CLASS}>
          <div className="flex w-full items-center justify-end gap-2">
            <button
              type="button"
              disabled={deleting}
              onClick={onClose}
              className={METABOT_BTN_FLAT_CLASS}
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              data-slot="metabot-delete-confirm-action"
              disabled={countdown > 0 || deleting}
              onClick={() => void handleConfirm()}
              className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[7px] bg-red-600 px-3.5 text-[12px] font-semibold text-white hover:bg-red-700 active:scale-[0.97] transition-[background-color,transform] duration-150 disabled:opacity-45 disabled:cursor-not-allowed tabular-nums"
            >
              {deleting
                ? i18nService.t('metabotDeleting')
                : countdown > 0
                  ? `${i18nService.t('metabotDeleteConfirmAction')} (${countdown}s)`
                  : i18nService.t('metabotDeleteConfirmAction')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MetaBotDeleteConfirmModal;
