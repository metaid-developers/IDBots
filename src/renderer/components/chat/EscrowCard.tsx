/**
 * EscrowCard — chat escrow-trade card skeleton (S3 slice, design docs 03/04).
 *
 * Rendered from an `escrow-card` fence in any markdown surface (CoWork
 * conversation, A2A private chat, group/group-task transcripts share the
 * MarkdownContent path — same contract as the nft-card cards). This slice is
 * a skeleton: it shows 当前状态 / 下一步该谁做什么 / 剩余时间 / 在押证明 and an
 * active 申诉/复核 entry (04 分支三): expanding it shows the appeal rules and
 * a copyable escrow_order_act dispute_open template for the session bot to
 * execute — the entry instructs, it never moves anything itself. No funds
 * buttons, ever — the fiat rail moves money point-to-point outside the system
 * (zero-funds-flow red line, doc 03 §5.1); neither automatic release nor
 * automatic refund exists anywhere in this flow.
 *
 * Styling deliberately shares the NftCard vocabulary (rounded-[16px] source
 * dark card, small chips) but lives under its own data marker so it never
 * collides with the `pay-card` PaymentCard (feat/s3-paycard, not merged this
 * slice) or `nft-card` (data-nft-card): each fence tag is disjoint.
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

const proofHead = (proof: string | undefined): string | null => {
  if (!proof) return null;
  return proof.length > 18 ? `${proof.slice(0, 9)}…${proof.slice(-6)}` : proof;
};

const EscrowCard: React.FC<{ data: EscrowCardData; now?: number }> = ({ data, now }) => {
  const nowMs = useMemo(() => now ?? Date.now(), [now]);
  const remaining = escrowRemainingTimeText(data, nowMs);
  const stageBadge = data.timerHours ? `T${['CREATED', 'ITEM_ESCROWED', 'PAID_EVIDENCE_UPLOADED', 'SELLER_CONFIRMED'].indexOf(data.state) + 1}` : null;
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
      className="my-2 max-w-sm rounded-[16px] border border-white/10 bg-[#202127] p-3 text-[13px] leading-5 text-slate-200 shadow-sm"
    >
      {/* 头部：订单号 + 状态徽标 */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
            <ShieldCheckIcon className="h-3.5 w-3.5 text-emerald-400/80" />
            <span>{i18nService.t('escrowCardTitle')}</span>
            <span className="font-normal text-slate-500">{data.orderId}</span>
          </div>
          {data.title ? <div className="mt-0.5 truncate text-sm font-medium text-slate-100">{data.title}</div> : null}
        </div>
        <span className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold leading-tight ${escrowCardStateTone(data.state)}`}>
          {escrowCardStateLabel(data.state)}
        </span>
      </div>

      {/* 标的与对价（钱 never 经过卡片/平台；此处只是金额展示） */}
      <div className="mt-2 flex items-center justify-between gap-2 text-[12px]">
        <span className="truncate text-slate-400">
          {escrowGoodsKindLabel(data.kind)}
          {data.custodyProof ? (
            <span className="ml-1.5 font-mono text-[10px] text-slate-500" title={`${i18nService.t('escrowCardCustodyTitle')}: ${data.custodyProof}`}>
              {i18nService.t('escrowCardCustodyBadge')} {proofHead(data.custodyProof)}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 font-semibold text-slate-100">{formatEscrowYuan(data.amountCents)}</span>
      </div>

      {/* 双方 + 担保人 */}
      <div className="mt-2 grid grid-cols-3 gap-1 text-center text-[11px] text-slate-400">
        <span className="truncate">{i18nService.t('escrowCardPartySeller')} {data.parties.seller}</span>
        <span className="truncate">{i18nService.t('escrowCardPartyBuyer')} {data.parties.buyer}</span>
        <span className="truncate text-emerald-300/80">{i18nService.t('escrowCardPartyAgent')} {data.parties.agent}</span>
      </div>

      {/* 下一步该谁做什么（03 状态表「允许动作」口径，担保 bot 算好传入） */}
      {data.next && data.state !== 'RELEASED' && data.state !== 'CANCELLED' && data.state !== 'REFUND_ROLLED_BACK' ? (
        <div className="mt-2 rounded-lg bg-white/5 px-2.5 py-1.5 text-[12px]">
          <span className="font-medium text-emerald-300">{i18nService.t('escrowCardNext')}</span>
          <span className="mx-1 text-slate-500">·</span>
          <span className="text-slate-400">{data.next.actor}</span>
          <span className="text-slate-200">{data.next.text}</span>
        </div>
      ) : null}

      {/* 剩余时间 + 计时器侧（T1–T4 超时后果见 03 §4：安全区自动取消/退货，
          非安全区绝不自动放款退款，转人工仲裁） */}
      {remaining && stageBadge ? (
        <div className="mt-2 flex items-center gap-1 text-[11px] text-slate-500">
          <ClockIcon className="h-3 w-3" />
          <span>
            {stageBadge} · {remaining}
          </span>
          <span className="text-slate-600">{i18nService.t('escrowCardTimeoutNote')}</span>
        </div>
      ) : null}

      {/* 仲裁/申诉入口（04 分支三）：一级=担保人调证裁决；二级=owner 复核
          （裁决 basis 加 owner: 前缀）。入口只展开规则与动作模板，无资金按钮。 */}
      {data.disputeOpen || data.state === 'DISPUTED' ? (
        <div className="mt-2 flex items-center gap-1 text-[11px] text-orange-300">
          <ExclamationTriangleIcon className="h-3 w-3" />
          <span>{i18nService.t('escrowCardDisputeNote')}</span>
        </div>
      ) : null}
      {!ESCROW_CARD_TERMINAL_STATES.includes(data.state) ? (
        <div className="mt-2">
          <button
            type="button"
            data-escrow-appeal="toggle"
            onClick={() => setAppealOpen((open) => !open)}
            className="rounded px-1.5 py-px text-[10px] text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200"
          >
            {i18nService.t('escrowCardAppealToggle')}
          </button>
          {appealOpen ? (
            <div
              data-escrow-appeal-panel="true"
              className="mt-1.5 rounded-lg bg-white/5 px-2.5 py-2 text-[11px] leading-5 text-slate-400"
            >
              <div>{i18nService.t('escrowCardAppealRules')}</div>
              <div className="mt-1 flex items-center justify-between gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-300" title={appealTemplate}>
                  {appealTemplate}
                </code>
                <button
                  type="button"
                  data-escrow-appeal-copy="true"
                  onClick={copyAppealTemplate}
                  className="shrink-0 rounded px-1.5 py-px text-[10px] text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200"
                >
                  {appealCopied ? i18nService.t('escrowCardAppealCopied') : i18nService.t('escrowCardAppealCopy')}
                </button>
              </div>
              <div className="mt-1 text-slate-500">{i18nService.t('escrowCardAppealHint')}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export default EscrowCard;
