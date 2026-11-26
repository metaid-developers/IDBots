/**
 * MetaBot Restore from Mnemonic Modal (S1 — Studio Linear)
 *
 * Restores an existing MetaBot wallet & on-chain identity from a 12-word
 * mnemonic and HD derivation path, supporting whole-phrase paste and explicit
 * clipboard paste button.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ClipboardDocumentIcon,
  ExclamationTriangleIcon,
  KeyIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';
import { DEFAULT_METABOT_LIMIT, METABOT_LIMIT_REACHED_ERROR } from '../../../main/shared/metabotLimit';
import {
  METABOT_BTN_FLAT_CLASS,
  METABOT_BTN_PRIMARY_CLASS,
  METABOT_CLEAN_INPUT_CLASS,
  METABOT_ICON_BTN_CLASS,
  METABOT_MODAL_BACKDROP_CLASS,
  METABOT_MODAL_FOOTER_CLASS,
  METABOT_MODAL_HEADER_CLASS,
  METABOT_MODAL_SCRIM_CLASS,
  METABOT_MODAL_SHELL_CLASS,
  METABOT_MODAL_SUBSURFACE_CLASS,
} from './metaBotCardPresentation.js';

export interface MetaBotRestoreMnemonicModalProps {
  onClose: () => void;
  onRestored: (metabot: Metabot) => void;
}

const DEFAULT_DERIVATION_PATH = "m/44'/10001'/0'/0/0";
const formatMetabotLimitReached = () =>
  i18nService.t('metabotLimitReached').replace('{limit}', String(DEFAULT_METABOT_LIMIT));

const MetaBotRestoreMnemonicModal: React.FC<MetaBotRestoreMnemonicModalProps> = ({ onClose, onRestored }) => {
  const [words, setWords] = useState<string[]>(Array.from({ length: 12 }, () => ''));
  const [path, setPath] = useState(DEFAULT_DERIVATION_PATH);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'importing' | 'success'>('idle');
  const [resultMetabot, setResultMetabot] = useState<Metabot | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !loading) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [loading, onClose]);

  const normalizedMnemonic = useMemo(
    () => words.map((w) => w.trim().toLowerCase()).filter(Boolean).join(' '),
    [words],
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

  const handlePasteFromClipboard = async () => {
    setError('');
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
        setError(i18nService.t('metabotRestorePasteEmpty'));
        return;
      }
      const text = await navigator.clipboard.readText();
      const parts = text.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        setError(i18nService.t('metabotRestorePasteEmpty'));
        return;
      }
      handlePasteMnemonic(text);
    } catch {
      setError(i18nService.t('metabotRestorePasteEmpty'));
    }
  };

  const resolveErrorMessage = (raw?: string) => {
    switch (raw) {
      case 'NAME_DUPLICATE':
        return i18nService.t('metabotRestoreNameDuplicate');
      case 'WALLET_ALREADY_LINKED':
        return i18nService.t('metabotRestoreWalletAlreadyLinked');
      case 'NAME_EMPTY':
        return i18nService.t('metabotRestoreNameMissing');
      case 'MNEMONIC_INVALID':
        return i18nService.t('metabotRestoreMnemonicInvalid');
      case 'PATH_INVALID':
        return i18nService.t('metabotRestorePathInvalid');
      case 'METABOT_WALLET_IN_USE':
        return i18nService.t('metabotRestoreWalletInUse');
      case METABOT_LIMIT_REACHED_ERROR:
        return formatMetabotLimitReached();
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
    <div className={METABOT_MODAL_BACKDROP_CLASS} data-slot="metabot-restore-mnemonic-modal">
      <div
        className={METABOT_MODAL_SCRIM_CLASS}
        onClick={loading ? undefined : onClose}
        aria-hidden
      />
      <div
        className={`${METABOT_MODAL_SHELL_CLASS} w-full max-w-[600px] max-h-[88vh]`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={i18nService.t('metabotRestoreTitle')}
      >
        {/* Header */}
        <div className={METABOT_MODAL_HEADER_CLASS}>
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-slate-900/[0.08] dark:border-white/[0.09] bg-white dark:bg-[#141e2e] text-[#181d25] dark:text-[#f3f5f8]">
              <KeyIcon className="h-4 w-4" aria-hidden />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[14px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                {i18nService.t('metabotRestoreTitle')}
              </div>
            </div>
          </div>

          <button
            type="button"
            disabled={loading}
            onClick={onClose}
            className={METABOT_ICON_BTN_CLASS}
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div className="flex items-start gap-2.5 rounded-[9px] border border-amber-500/35 bg-amber-500/[0.08] px-3.5 py-2.5 text-[12px] leading-relaxed text-amber-800 dark:text-amber-300">
            <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            <span>{i18nService.t('metabotRestoreHint')}</span>
          </div>

          {status === 'importing' && (
            <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} flex items-center gap-3 px-4 py-4`}>
              <ArrowPathIcon className="h-5 w-5 animate-spin text-[#8a6d00] dark:text-[#FFDC51] shrink-0" />
              <div>
                <p className="text-[13px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                  {i18nService.t('metabotRestoreImporting')}
                </p>
                <p className="mt-0.5 text-[12px] text-[#5a6577] dark:text-[#94a3b8]">
                  {i18nService.t('metabotRestoreImportingHint')}
                </p>
              </div>
            </div>
          )}

          {status === 'success' && resultMetabot && (
            <div className="rounded-[10px] border border-emerald-500/35 bg-emerald-500/[0.08] px-4 py-4 flex items-start gap-3">
              <CheckCircleIcon className="h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-[13.5px] font-bold text-emerald-800 dark:text-emerald-300">
                  {i18nService.t('metabotRestoreSuccess')}
                </p>
                <p className="mt-1 text-[12px] text-emerald-700 dark:text-emerald-400">
                  {resultMetabot.name}
                </p>
              </div>
            </div>
          )}

          {status === 'idle' && (
            <>
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <label className="text-[12px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                    {i18nService.t('metabotRestoreMnemonicLabel')}
                  </label>
                  <button
                    type="button"
                    data-slot="metabot-restore-paste"
                    onClick={() => void handlePasteFromClipboard()}
                    className="inline-flex items-center gap-1 rounded-[6px] border border-slate-900/[0.10] dark:border-white/[0.10] bg-[#f8fafc] dark:bg-[#182538] px-2.5 py-1 text-[11px] font-semibold text-[#181d25] dark:text-[#f3f5f8] hover:bg-[#eef1f5] dark:hover:bg-white/[0.08] transition-colors"
                  >
                    <ClipboardDocumentIcon className="h-3.5 w-3.5" aria-hidden />
                    <span>{i18nService.t('metabotRestorePasteAction')}</span>
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  {words.map((word, index) => (
                    <div
                      key={index}
                      className="flex items-center gap-1.5 rounded-[7px] border border-slate-900/[0.11] dark:border-white/[0.10] bg-[#f8fafc] dark:bg-[#131d2c] px-2.5 py-1.5 focus-within:border-[#d4af1f] focus-within:bg-white dark:focus-within:bg-[#141e2e]"
                    >
                      <span className="font-mono text-[10.5px] font-bold tabular-nums text-[#8c96a6] select-none">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <input
                        type="text"
                        value={word}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => handleWordChange(index, event.target.value)}
                        onPaste={(event) => {
                          const pasted = event.clipboardData.getData('text');
                          if (pasted && /\s+/.test(pasted.trim())) {
                            event.preventDefault();
                            handlePasteMnemonic(pasted);
                          }
                        }}
                        className="w-full min-w-0 bg-transparent font-mono text-[12.5px] text-[#181d25] dark:text-[#f3f5f8] outline-none"
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-[12px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                  {i18nService.t('metabotRestorePathLabel')}
                </label>
                <input
                  type="text"
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  className={`${METABOT_CLEAN_INPUT_CLASS} font-mono py-2`}
                />
              </div>

              {error && (
                <div className="flex items-center justify-between gap-2 rounded-[8px] border border-rose-500/35 bg-rose-500/[0.08] px-3 py-2 text-[12px] text-red-600 dark:text-rose-400">
                  <span>{error}</span>
                  <button
                    type="button"
                    onClick={handleRetry}
                    className="shrink-0 font-semibold underline"
                  >
                    {i18nService.t('metabotRestoreRetry')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className={METABOT_MODAL_FOOTER_CLASS}>
          <div className="flex w-full items-center justify-end gap-2">
            {status === 'success' ? (
              <button type="button" onClick={onClose} className={METABOT_BTN_PRIMARY_CLASS}>
                {i18nService.t('close')}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={loading}
                  onClick={onClose}
                  className={METABOT_BTN_FLAT_CLASS}
                >
                  {i18nService.t('cancel')}
                </button>
                <button
                  type="button"
                  data-slot="metabot-restore-submit"
                  disabled={!canSubmit}
                  onClick={() => void handleSubmit()}
                  className={METABOT_BTN_PRIMARY_CLASS}
                >
                  {loading ? i18nService.t('metabotRestoreImporting') : i18nService.t('metabotRestoreAction')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MetaBotRestoreMnemonicModal;
