/**
 * EscrowCard — chat escrow-trade card aligned to `TK_CARD_COMPACT_SHELL`
 * light & dark visual system while preserving all zero-funds-flow contracts
 * (`data-escrow-card="true"`, single appeal toggle button when collapsed, no
 * disabled or fiat-movement buttons).
 */

import React, { useMemo, useState } from 'react';
import {
  ExclamationTriangleIcon,
  ClockIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import {
  buildEscrowAppealTemplate,
  escrowCardStateLabel,
  escrowCardStateTone,
  escrowGoodsKindLabel,
  escrowRemainingTimeText,
  ESCROW_CARD_TERMINAL_STATES,
  formatEscrowYuan,
  type EscrowCardData,
} from './escrowCardSyntax';
import { TK_CARD_COMPACT_SHELL, TK_INSET_BOX } from './tokenSuiteUi';

const proofHead = (proof: string | undefined): string | null => {
  if (!proof) return null;
  return proof.length > 18 ? `${proof.slice(0, 9)}…${proof.slice(-6)}` : proof;
};

const EscrowCard: React.FC<{ data: EscrowCardData; now?: number }> = ({ data, now }) => {
  const nowMs = useMemo(() => now ?? Date.now(), [now]);
  const remaining = escrowRemainingTimeText(data, nowMs);
  const stageBadge = data.timerHours
    ? `T${['CREATED', 'ITEM_ESCROWED', 'PAID_EVIDENCE_UPLOADED', 'SELLER_CONFIRMED'].indexOf(data.state) + 1}`
    : null;
  const [appealOpen, setAppealOpen] = useState(false);
  const [appealCopied, setAppealCopied] = useState(false);
  const appealTemplate = useMemo(() => buildEscrowAppealTemplate(data.orderId), [data.orderId]);
  const copyAppealTemplate = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(appealTemplate).catch(() => {});
    setAppealCopied(true);
    window.setTimeout(() => setAppealCopied(false), 1500);
  };

  return (
    <div
      data-escrow-card="true"
      data-escrow-state={data.state}
      data-escrow-order={data.orderId}
      className={`${TK_CARD_COMPACT_SHELL} text-[13px] leading-5`}
    >
      {/* Header: Order ID + State Badge */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#5b6472] dark:text-[#9aa3b2]">
            <ShieldCheckIcon className="h-3.5 w-3.5 text-[#0f9d68] dark:text-[#34d399]" />
            <span>{i18nService.t('escrowCardTitle')}</span>
            <span className="font-mono font-normal text-[#8a94a6]">{data.orderId}</span>
          </div>
          {data.title ? (
            <div className="mt-0.5 truncate text-[14px] font-bold text-[#1f2329] dark:text-[#f4f5f8]">
              {data.title}
            </div>
          ) : null}
        </div>
        <span className={`shrink-0 rounded-[6px] px-1.5 py-0.5 text-[10px] font-semibold leading-tight ${escrowCardStateTone(data.state)}`}>
          {escrowCardStateLabel(data.state)}
        </span>
      </div>

      {/* Custody & Reference Amount */}
      <div className={`mt-2.5 flex items-center justify-between gap-2 text-[12px] ${TK_INSET_BOX}`}>
        <span className="truncate text-[#5b6472] dark:text-[#9aa3b2]">
          {escrowGoodsKindLabel(data.kind)}
          {data.custodyProof ? (
            <span
              className="ml-1.5 font-mono text-[10px] text-[#8a94a6]"
              title={`${i18nService.t('escrowCardCustodyTitle')}: ${data.custodyProof}`}
            >
              {i18nService.t('escrowCardCustodyBadge')} {proofHead(data.custodyProof)}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 font-bold tabular-nums text-[#1f2329] dark:text-[#f4f5f8]">
          {formatEscrowYuan(data.amountCents)}
        </span>
      </div>

      {/* Parties */}
      <div className="mt-2 grid grid-cols-3 gap-1 text-center text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
        <span className="truncate">{i18nService.t('escrowCardPartySeller')} {data.parties.seller}</span>
        <span className="truncate">{i18nService.t('escrowCardPartyBuyer')} {data.parties.buyer}</span>
        <span className="truncate font-medium text-[#0f9d68] dark:text-[#34d399]">
          {i18nService.t('escrowCardPartyAgent')} {data.parties.agent}
        </span>
      </div>

      {/* Next Step */}
      {data.next && data.state !== 'RELEASED' && data.state !== 'CANCELLED' && data.state !== 'REFUND_ROLLED_BACK' ? (
        <div className={`mt-2 text-[12px] ${TK_INSET_BOX}`}>
          <span className="font-semibold text-[#0f9d68] dark:text-[#34d399]">{i18nService.t('escrowCardNext')}</span>
          <span className="mx-1 text-[#8a94a6]">·</span>
          <span className="text-[#5b6472] dark:text-[#9aa3b2]">{data.next.actor}</span>
          <span className="text-[#1f2329] dark:text-[#f4f5f8]">{data.next.text}</span>
        </div>
      ) : null}

      {/* Remaining Timer */}
      {remaining && stageBadge ? (
        <div className="mt-2 flex items-center gap-1 text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
          <ClockIcon className="h-3.5 w-3.5 text-[#8a94a6]" />
          <span className="tabular-nums">
            {stageBadge} · {remaining}
          </span>
          <span className="text-[#8a94a6]">{i18nService.t('escrowCardTimeoutNote')}</span>
        </div>
      ) : null}

      {/* Dispute / Appeal */}
      {data.disputeOpen || data.state === 'DISPUTED' ? (
        <div className="mt-2 flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
          <ExclamationTriangleIcon className="h-3.5 w-3.5" />
          <span>{i18nService.t('escrowCardDisputeNote')}</span>
        </div>
      ) : null}
      {!ESCROW_CARD_TERMINAL_STATES.includes(data.state) ? (
        <div className="mt-2 border-t border-slate-900/[0.06] pt-2 dark:border-white/[0.07]">
          <button
            type="button"
            data-escrow-appeal="toggle"
            onClick={() => setAppealOpen((open) => !open)}
            className="rounded-[8px] px-2 py-0.5 text-[10.5px] font-medium text-[#5b6472] transition-colors hover:bg-black/5 hover:text-[#1f2329] dark:text-[#9aa3b2] dark:hover:bg-white/[0.06] dark:hover:text-[#f4f5f8]"
          >
            {i18nService.t('escrowCardAppealToggle')}
          </button>
          {appealOpen ? (
            <div
              data-escrow-appeal-panel="true"
              className={`mt-1.5 text-[11px] leading-5 text-[#5b6472] dark:text-[#9aa3b2] ${TK_INSET_BOX}`}
            >
              <div>{i18nService.t('escrowCardAppealRules')}</div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-[#1f2329] dark:text-[#f4f5f8]" title={appealTemplate}>
                  {appealTemplate}
                </code>
                <button
                  type="button"
                  data-escrow-appeal-copy="true"
                  onClick={copyAppealTemplate}
                  className="shrink-0 rounded-[8px] px-2 py-0.5 text-[10px] font-semibold text-[#5b6472] transition-colors hover:bg-black/5 hover:text-[#1f2329] dark:text-[#9aa3b2] dark:hover:bg-white/[0.08] dark:hover:text-[#f4f5f8]"
                >
                  {appealCopied ? i18nService.t('escrowCardAppealCopied') : i18nService.t('escrowCardAppealCopy')}
                </button>
              </div>
              <div className="mt-1 text-[#8a94a6]">{i18nService.t('escrowCardAppealHint')}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export default EscrowCard;
