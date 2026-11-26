/**
 * MetaBot Backup Mnemonic Modal (M1 — Studio Linear Privacy-Shielded Vault)
 *
 * Displays the 12-word recovery phrase behind a default frosted privacy shield
 * (`revealed = false`) so shoulder-surfers or screenshots cannot capture words
 * unintentionally. Includes HD derivation path, amber non-custodial notice,
 * 2-digit numbered monospace grid, and one-click copy.
 */

import React, { useEffect, useState } from 'react';
import {
  CheckIcon,
  DocumentDuplicateIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  EyeSlashIcon,
  KeyIcon,
  ShieldCheckIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';
import {
  METABOT_BTN_FLAT_CLASS,
  METABOT_BTN_PRIMARY_CLASS,
  METABOT_ICON_BTN_CLASS,
  METABOT_MICRO_BADGE_CLASS,
  METABOT_MODAL_BACKDROP_CLASS,
  METABOT_MODAL_FOOTER_CLASS,
  METABOT_MODAL_HEADER_CLASS,
  METABOT_MODAL_SCRIM_CLASS,
  METABOT_MODAL_SHELL_CLASS,
  METABOT_MODAL_SUBSURFACE_CLASS,
} from './metaBotCardPresentation.js';

export interface MetaBotBackupMnemonicModalProps {
  metabot: Metabot;
  onClose: () => void;
}

const MetaBotBackupMnemonicModal: React.FC<MetaBotBackupMnemonicModalProps> = ({ metabot, onClose }) => {
  const [mnemonic, setMnemonic] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [revealed, setRevealed] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    window.electron.idbots
      .getMetaBotMnemonic(metabot.id)
      .then((res) => {
        if (!active) return;
        if (!res.success || !res.mnemonic) {
          setError(res.error || i18nService.t('metabotBackupMnemonicLoadFailed'));
          return;
        }
        setMnemonic(res.mnemonic);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : i18nService.t('metabotBackupMnemonicLoadFailed'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [metabot.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const words = mnemonic.trim().split(/\s+/).filter(Boolean);
  const derivationPath = (metabot as Metabot & { path?: string }).path || "m/44'/10001'/0'/0/0";

  const handleCopy = () => {
    if (!mnemonic) return;
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(mnemonic).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
        window.dispatchEvent(
          new CustomEvent('app:showToast', { detail: i18nService.t('metabotMnemonicCopiedToast') }),
        );
      });
    }
  };

  return (
    <div className={METABOT_MODAL_BACKDROP_CLASS} data-slot="metabot-backup-mnemonic-modal">
      <div className={METABOT_MODAL_SCRIM_CLASS} onClick={onClose} aria-hidden />
      <div
        className={`${METABOT_MODAL_SHELL_CLASS} w-full max-w-[560px]`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={i18nService.t('metabotBackupMnemonic')}
      >
        {/* Studio Linear Header */}
        <div className={METABOT_MODAL_HEADER_CLASS}>
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-slate-900/[0.08] dark:border-white/[0.09] bg-white dark:bg-[#141e2e] text-[#181d25] dark:text-[#f3f5f8]">
              <ShieldCheckIcon className="h-4 w-4" aria-hidden />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[14px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                {i18nService.t('metabotBackupMnemonic')}
              </div>
              <div className="truncate text-[11.5px] text-[#5a6577] dark:text-[#94a3b8]">
                {metabot.name}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className={METABOT_ICON_BTN_CLASS}
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Amber Non-Custodial Warning */}
          <div className="flex items-start gap-2.5 rounded-[9px] border border-amber-500/35 bg-amber-500/[0.08] px-3.5 py-2.5 text-[12px] leading-relaxed text-amber-800 dark:text-amber-300">
            <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            <span>{i18nService.t('metabotBackupMnemonicHint')}</span>
          </div>

          {/* HD Derivation Path & Shield Toggle */}
          <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5`}>
            <div className="flex min-w-0 items-center gap-2 text-[11.5px]">
              <KeyIcon className="h-3.5 w-3.5 shrink-0 text-[#5a6577] dark:text-[#94a3b8]" aria-hidden />
              <span className="font-semibold text-[#5a6577] dark:text-[#94a3b8]">HD Path</span>
              <code className={`${METABOT_MICRO_BADGE_CLASS} font-mono`} data-slot="metabot-mnemonic-path">
                {derivationPath}
              </code>
            </div>

            {!loading && !error && words.length > 0 && (
              <button
                type="button"
                data-slot="metabot-mnemonic-toggle-reveal"
                onClick={() => setRevealed((prev) => !prev)}
                className="inline-flex items-center gap-1 rounded-[6px] border border-slate-900/[0.10] dark:border-white/[0.10] bg-white dark:bg-[#141e2e] px-2.5 py-1 text-[11.5px] font-semibold text-[#181d25] dark:text-[#f3f5f8] hover:bg-[#eef1f5] dark:hover:bg-white/[0.06] transition-colors"
              >
                {revealed ? (
                  <>
                    <EyeSlashIcon className="h-3.5 w-3.5" aria-hidden />
                    <span>{i18nService.t('metabotMnemonicConcealAction')}</span>
                  </>
                ) : (
                  <>
                    <EyeIcon className="h-3.5 w-3.5" aria-hidden />
                    <span>{i18nService.t('metabotMnemonicRevealAction')}</span>
                  </>
                )}
              </button>
            )}
          </div>

          {/* 12-Word Vault Grid with Frosted Privacy Shield */}
          {loading ? (
            <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} py-10 text-center text-[13px] text-[#5a6577] dark:text-[#94a3b8]`}>
              {i18nService.t('metabotBackupMnemonicLoading')}
            </div>
          ) : error ? (
            <div className="rounded-[9px] border border-rose-500/35 bg-rose-500/[0.08] px-4 py-3 text-[12.5px] text-red-600 dark:text-rose-400">
              {error}
            </div>
          ) : (
            <div className="relative overflow-hidden rounded-[11px] border border-slate-900/[0.10] dark:border-white/[0.10] bg-[#f8fafc] dark:bg-[#0f1724] p-3.5">
              <div
                data-slot="metabot-mnemonic-grid"
                data-revealed={revealed ? 'true' : 'false'}
                className={`grid grid-cols-3 gap-2 transition-[filter,opacity] duration-200 ${
                  revealed ? 'blur-0 opacity-100 select-text' : 'blur-[6px] opacity-60 select-none pointer-events-none'
                }`}
              >
                {words.map((word, idx) => (
                  <div
                    key={`${idx}-${word}`}
                    className="flex items-center gap-2 rounded-[7px] border border-slate-900/[0.08] dark:border-white/[0.08] bg-white dark:bg-[#141e2e] px-2.5 py-2"
                  >
                    <span className="font-mono text-[10.5px] font-bold tabular-nums text-[#8c96a6] dark:text-[#64748b] select-none">
                      {String(idx + 1).padStart(2, '0')}
                    </span>
                    <span className="truncate font-mono text-[12.5px] font-semibold text-[#181d25] dark:text-[#f3f5f8]">
                      {revealed ? word : '••••••'}
                    </span>
                  </div>
                ))}
              </div>

              {!revealed && (
                <div
                  data-slot="metabot-mnemonic-shield"
                  className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-white/55 dark:bg-[#0f1724]/65 backdrop-blur-[3px] px-4 text-center"
                >
                  <p className="max-w-xs text-[12px] font-semibold text-[#181d25] dark:text-[#f3f5f8]">
                    {i18nService.t('metabotMnemonicPrivacyMasked')}
                  </p>
                  <button
                    type="button"
                    onClick={() => setRevealed(true)}
                    className={METABOT_BTN_PRIMARY_CLASS}
                  >
                    <EyeIcon className="h-3.5 w-3.5" aria-hidden />
                    <span>{i18nService.t('metabotMnemonicRevealAction')}</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={METABOT_MODAL_FOOTER_CLASS}>
          <button
            type="button"
            data-slot="metabot-mnemonic-copy"
            onClick={handleCopy}
            disabled={loading || !!error || !mnemonic}
            className={METABOT_BTN_FLAT_CLASS}
          >
            {copied ? (
              <CheckIcon className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
            ) : (
              <DocumentDuplicateIcon className="h-3.5 w-3.5" aria-hidden />
            )}
            <span>
              {copied
                ? i18nService.t('metabotBackupMnemonicCopied')
                : i18nService.t('metabotMnemonicCopyAction')}
            </span>
          </button>

          <button type="button" onClick={onClose} className={METABOT_BTN_PRIMARY_CLASS}>
            {i18nService.t('metabotMnemonicBackedUpDone')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default MetaBotBackupMnemonicModal;
