/**
 * CommerceIntentConfirmModal — the host-native confirmation card shown when a
 * MetaApp raises `browser.commerce.askTwinToBuy` or
 * `browser.social.addFriendPrompt` (REQ-E-01). Pure UI: the params shown here
 * are the sanitized values from commerceBridgeContract; confirming only
 * dispatches the commerce window event (WS-D mounts the downstream purchase
 * / friend flow on it). Nothing is charged or sent by this card itself.
 */

import React from 'react';
import {
  formatCnyCents,
  formatMeMilli,
  tCommerce,
  type CommerceI18nKey,
  type CommerceLang,
} from './commercePromoI18n';
import type { AddFriendPromptParams, AskTwinToBuyParams } from './commerceBridgeContract';

export interface CommerceIntentConfirmModalProps {
  kind: 'askTwinToBuy' | 'addFriendPrompt';
  params: AskTwinToBuyParams | AddFriendPromptParams;
  lang: CommerceLang;
  onConfirm(): void;
  onCancel(): void;
}

const Field: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-2 text-xs leading-5">
      <dt className="w-20 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{label}</dt>
      <dd className={`min-w-0 flex-1 break-all dark:text-claude-darkText text-claude-text ${mono ? 'font-mono text-[11px]' : ''}`}>{value}</dd>
    </div>
  );
};

const modeLabel = (mode: string | undefined, lang: CommerceLang): string => {
  if (mode === 'negotiate') return tCommerce('commerceModeNegotiate', lang);
  if (mode === 'inquire_unlisted') return tCommerce('commerceModeInquire', lang);
  return tCommerce('commerceModeBuy', lang);
};

export const CommerceIntentConfirmModal: React.FC<CommerceIntentConfirmModalProps> = ({
  kind,
  params,
  lang,
  onConfirm,
  onCancel,
}) => {
  const t = (key: CommerceI18nKey) => tCommerce(key, lang);
  const buyParams = kind === 'askTwinToBuy' ? (params as AskTwinToBuyParams) : null;
  const friendParams = kind === 'addFriendPrompt' ? (params as AddFriendPromptParams) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={t('commerceConfirmTitle')}>
      <div className="w-full max-w-[420px] rounded-xl border p-4 shadow-lg dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface" data-commerce-intent-card={kind}>
        <div className="flex items-start gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-claude-accent/10 text-claude-accent">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-[18px] w-[18px]">
              <path d="M3 3h2l2.6 12.4a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 2-1.6L21 8H6" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="10" cy="20" r="1" />
              <circle cx="17" cy="20" r="1" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-claude-accent">{t('commerceConfirmTitle')}</div>
            <div className="mt-0.5 text-xs leading-5 dark:text-claude-darkText text-claude-text">
              {kind === 'askTwinToBuy' ? t('commerceConfirmIntroBuy') : t('commerceConfirmIntroFriend')}
            </div>
          </div>
        </div>

        <dl className="mt-3 space-y-1.5">
          {buyParams && (
            <>
              <Field label={t('commerceFieldItem')} value={buyParams.itemName} />
              <Field label={t('commerceFieldCollection')} value={buyParams.collectionName} />
              <Field
                label={t('commerceFieldSeller')}
                value={buyParams.sellerName || buyParams.sellerGlobalMetaId}
                mono={!buyParams.sellerName}
              />
              {buyParams.priceMeMilli !== undefined && (
                <Field label={t('commerceFieldPrice')} value={formatMeMilli(buyParams.priceMeMilli)} />
              )}
              {buyParams.priceCnyCents !== undefined && (
                <Field label={t('commerceFieldFiatPrice')} value={formatCnyCents(buyParams.priceCnyCents)} />
              )}
              <Field label={t('commerceFieldMode')} value={modeLabel(buyParams.mode, lang)} />
            </>
          )}
          {friendParams && (
            <>
              <Field
                label={t('commerceFieldSeller')}
                value={friendParams.targetName || friendParams.targetGlobalMetaId}
                mono={!friendParams.targetName}
              />
              {friendParams.greeting ? <Field label="✎" value={friendParams.greeting} /> : null}
            </>
          )}
        </dl>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
            onClick={onCancel}
          >
            {t('commerceCancel')}
          </button>
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-lg bg-claude-accent px-3 py-1.5 text-xs font-medium text-claude-accentInk transition-colors hover:bg-claude-accentHover"
            onClick={onConfirm}
            data-commerce-confirm-button={kind}
          >
            {t('commerceSendToTwin')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CommerceIntentConfirmModal;
