import React, { useEffect, useMemo, useState } from 'react';
import { ct, formatCnyDisplay, formatMeDisplay } from '../commerce/commerceTradeI18n';
import { dispatchCommerceIntent } from '../commerce/commerceTradeEvents';
import { shortAddress } from './nftCardIdentity';
import type { NftNegotiateCardData } from './nftSuiteSyntax';
import {
  CopyShortHashButton,
  TK_BENTO_CELL,
  TK_BTN_PRIMARY,
  TK_BTN_SECONDARY,
  TK_CARD_SHELL,
  TK_CHIP_BTN,
  TK_INSET_BOX,
  dispatchSuiteComposerDraft,
} from './tokenSuiteUi';
import { NftProtocolBadge, NftSuiteThumb, NftVerifiedPill } from './nftSuiteUi';
import { formatNftPrice } from './NftCard';

export interface NftNegotiateCardProps {
  data: NftNegotiateCardData;
  className?: string;
}

function formatRemainingCountdown(expiresAtSec: number | undefined, nowMs: number): {
  text: string | null;
  expired: boolean;
} {
  if (!expiresAtSec || !Number.isFinite(expiresAtSec)) {
    return { text: null, expired: false };
  }
  const targetMs = expiresAtSec > 1e12 ? expiresAtSec : expiresAtSec * 1000;
  const diffSec = Math.floor((targetMs - nowMs) / 1000);
  if (diffSec <= 0) {
    return { text: ct('Quote Expired', '特批已过期'), expired: true };
  }
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    const remM = mins % 60;
    return { text: `${hrs}h ${remM}m`, expired: false };
  }
  return {
    text: `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`,
    expired: false,
  };
}

export const NftNegotiateCard: React.FC<NftNegotiateCardProps> = ({ data, className = '' }) => {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!data.quoteExpiresAt) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [data.quoteExpiresAt]);

  const countdown = useMemo(
    () => formatRemainingCountdown(data.quoteExpiresAt, nowMs),
    [data.quoteExpiresAt, nowMs],
  );

  const serial = data.tokenIndex || (data.number != null ? String(data.number) : null);
  const title = data.name || `${ct('Digital Item', '数字商品')}${serial ? ` #${serial}` : ''}`;

  const savingsInfo = useMemo(() => {
    const orig = data.originalPriceMeMilli;
    const agreed = data.agreedPriceMeMilli ?? data.proposedPriceMeMilli;
    if (orig != null && orig > 0 && agreed != null && agreed > 0 && orig > agreed) {
      const saved = orig - agreed;
      const pct = Math.round((saved / orig) * 100);
      return {
        savedDisplay: formatMeDisplay(saved),
        pct,
      };
    }
    return null;
  }, [data.originalPriceMeMilli, data.agreedPriceMeMilli, data.proposedPriceMeMilli]);

  // Mode 1: Seller approved special quote (`quote_accepted`)
  if (data.kind === 'quote_accepted') {
    const agreedMilli = data.agreedPriceMeMilli ?? data.proposedPriceMeMilli ?? 0;
    return (
      <div
        data-nft-negotiate-card="true"
        data-nft-negotiate-kind="quote_accepted"
        className={`${TK_CARD_SHELL} ${className}`}
      >
        <div className="flex items-center gap-3">
          <NftSuiteThumb
            name={title}
            serial={serial}
            format={data.format}
            icon={data.icon}
            imgUrl={data.imgUrl}
            size="lg"
            showSerialBadge
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-[6px] bg-[#0f9d68]/15 px-1.5 py-0.5 text-[10px] font-bold text-[#0f9d68] dark:text-[#34d399]">
                ✓ {ct('Special Quote Approved', '卖家已签发特批价')}
              </span>
              {countdown.text && (
                <span
                  className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-bold tabular-nums ${
                    countdown.expired
                      ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                      : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                  }`}
                >
                  ⏱ {countdown.text}
                </span>
              )}
            </div>
            <div className="mt-1 truncate text-[14.5px] font-bold text-[#1f2329] dark:text-[#f4f5f8]">
              {title}
            </div>
            <div className="mt-1 flex items-center gap-1">
              <NftVerifiedPill caVerified={data.caVerified} />
              <NftProtocolBadge format={data.format} compact />
            </div>
          </div>
        </div>

        {/* Strikethrough Comparison Box */}
        <div className="mt-2.5 rounded-[11px] border border-[#0f9d68]/28 bg-[#0f9d68]/[0.08] px-[11px] py-[9px] dark:border-[#34d399]/28 dark:bg-[#34d399]/[0.1]">
          <div className="flex items-baseline justify-between gap-2">
            <div>
              <div className="text-[10px] font-semibold text-[#0f9d68] dark:text-[#34d399]">
                {ct('Approved Deal Price', '专属特批成交价')}
              </div>
              <div className="mt-0.5 flex items-baseline gap-2">
                <span className="text-[20px] font-extrabold tabular-nums text-[#0f9d68] dark:text-[#34d399]">
                  {agreedMilli > 0 ? formatMeDisplay(agreedMilli) : ct('Approved', '已同意')}
                </span>
                {data.originalPriceMeMilli != null && data.originalPriceMeMilli > 0 && (
                  <span className="text-[12px] tabular-nums text-[#8a94a6] line-through">
                    {formatMeDisplay(data.originalPriceMeMilli)}
                  </span>
                )}
              </div>
              {data.agreedPriceCnyCents != null && data.agreedPriceCnyCents > 0 && (
                <div className="mt-0.5 text-[11px] tabular-nums text-[#5b6472] dark:text-[#9aa3b2]">
                  ≈ {formatCnyDisplay(data.agreedPriceCnyCents)}
                </div>
              )}
            </div>
            {savingsInfo && (
              <span className="shrink-0 rounded-full bg-[#0f9d68] px-2.5 py-1 text-[10.5px] font-extrabold tabular-nums text-white">
                {ct(`Save ${savingsInfo.savedDisplay} (-${savingsInfo.pct}%)`, `省 ${savingsInfo.savedDisplay} (-${savingsInfo.pct}%)`)}
              </span>
            )}
          </div>
        </div>

        {data.note && (
          <div className={`mt-2 text-[11.5px] text-[#5b6472] dark:text-[#9aa3b2] ${TK_INSET_BOX}`}>
            “{data.note}”
          </div>
        )}

        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            type="button"
            disabled={countdown.expired}
            onClick={() => {
              if (data.pinId && agreedMilli > 0) {
                dispatchCommerceIntent({
                  type: 'buy_with_me',
                  itemPinId: data.pinId,
                  itemName: title,
                  series: data.series,
                  priceMeMilli: agreedMilli,
                  priceCnyCents: data.agreedPriceCnyCents,
                  sellerAddress: data.sellerAddress,
                  sellerGlobalMetaId: data.sellerGlobalMetaId,
                  sellerName: data.sellerName,
                  shopMetaAppPinId: data.shopMetaAppPinId,
                  icon: data.icon,
                  imgUrl: data.imgUrl,
                });
              } else {
                dispatchSuiteComposerDraft(
                  ct(
                    `Buy ${title} (${data.pinId || ''}) at the approved quote of ${formatMeDisplay(agreedMilli)}.`,
                    `按卖家刚签发的特批价 ${formatMeDisplay(agreedMilli)} 立即锁单购买 ${title}（${data.pinId || ''}）。`,
                  ),
                );
              }
            }}
            className={TK_BTN_PRIMARY}
          >
            {countdown.expired
              ? ct('Quote Expired · Re-Inquire', '特批已过期 · 重新询价')
              : ct('✦ Lock & Buy at Quote Price', '✦ 按特批价立即锁单购买')}
          </button>
          {countdown.expired && (
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    `Send a fresh inquiry for ${title} (${data.pinId || ''}) to seller ${data.sellerGlobalMetaId || data.sellerName || ''}.`,
                    `重新向卖家 ${data.sellerGlobalMetaId || data.sellerName || ''} 发起 ${title}（${data.pinId || ''}）的议价请求。`,
                  ),
                )
              }
              className={TK_BTN_SECONDARY}
            >
              {ct('Re-Ask', '重新询价')}
            </button>
          )}
        </div>
      </div>
    );
  }

  // Mode 2: Seller received buyer inquiry (`inquiry_received`)
  if (data.kind === 'inquiry_received') {
    const buyerDisplay =
      data.buyerName ||
      (data.buyerAddress ? shortAddress(data.buyerAddress) : null) ||
      (data.buyerGlobalMetaId ? `${data.buyerGlobalMetaId.slice(0, 10)}…` : ct('Buyer', '买家'));

    return (
      <div
        data-nft-negotiate-card="true"
        data-nft-negotiate-kind="inquiry_received"
        className={`${TK_CARD_SHELL} ${className}`}
      >
        <div className="flex items-center gap-3">
          <NftSuiteThumb
            name={title}
            serial={serial}
            format={data.format}
            icon={data.icon}
            imgUrl={data.imgUrl}
            size="lg"
            showSerialBadge
          />
          <div className="min-w-0 flex-1">
            <span className="inline-flex rounded-[6px] bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-[#9a7300] dark:text-[#ffdc51]">
              💬 {ct('Buyer Offer Received', '收到买家议价单')}
            </span>
            <div className="mt-1 truncate text-[14.5px] font-bold text-[#1f2329] dark:text-[#f4f5f8]">
              {title}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
              {ct('From:', '来自买家:')} {buyerDisplay}
            </div>
          </div>
        </div>

        {/* 2-Col List vs Buyer Offer Bento */}
        <div className="mt-2.5 grid grid-cols-2 gap-1.5">
          <div className={TK_BENTO_CELL}>
            <div className="text-[10px] font-medium text-[#8a94a6]">
              {ct('Current Ask', '当前挂牌价')}
            </div>
            <div className="mt-0.5 text-[15px] font-bold tabular-nums text-[#1f2329] dark:text-[#f4f5f8]">
              {data.originalPriceMeMilli != null && data.originalPriceMeMilli > 0
                ? formatMeDisplay(data.originalPriceMeMilli)
                : ct('Unlisted', '未公开挂牌')}
            </div>
          </div>
          <div className={`${TK_BENTO_CELL} border border-[#b48a00]/25 bg-[#ffdc51]/[0.1] dark:border-[#ffdc51]/25 dark:bg-[#ffdc51]/[0.08]`}>
            <div className="text-[10px] font-semibold text-[#9a7300] dark:text-[#ffdc51]">
              {ct('Buyer Offer', '买家期望出价')}
            </div>
            <div className="mt-0.5 text-[15px] font-extrabold tabular-nums text-[#1f2329] dark:text-[#f4f5f8]">
              {data.proposedPriceMeMilli != null && data.proposedPriceMeMilli > 0
                ? formatMeDisplay(data.proposedPriceMeMilli)
                : ct('Ask Quote', '请求报价')}
            </div>
          </div>
        </div>

        {data.note && (
          <div className={`mt-2 text-[11.5px] text-[#5b6472] dark:text-[#9aa3b2] ${TK_INSET_BOX}`}>
            “{data.note}”
          </div>
        )}

        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              const targetPrice = data.proposedPriceMeMilli || data.originalPriceMeMilli || 0;
              dispatchSuiteComposerDraft(
                ct(
                  `Approve buyer ${data.buyerGlobalMetaId || buyerDisplay}'s inquiry for ${title} (${data.pinId || ''}) via goods_accept_inquiry${targetPrice > 0 ? ` at ${formatMeDisplay(targetPrice)}` : ''}.`,
                  `同意买家 ${data.buyerGlobalMetaId || buyerDisplay} 对 ${title}（${data.pinId || ''}）的议价，调用 goods_accept_inquiry 签发${targetPrice > 0 ? ` ${formatMeDisplay(targetPrice)}` : ''} 限时特批单。`,
                ),
              );
            }}
            className={TK_BTN_PRIMARY}
          >
            {ct('✦ Approve Special Quote', '✦ 同意签发特批单')}
          </button>
          <button
            type="button"
            onClick={() =>
              dispatchSuiteComposerDraft(
                ct(
                  `Counter-offer buyer ${data.buyerGlobalMetaId || buyerDisplay} for ${title} (${data.pinId || ''}) via goods_accept_inquiry at ME price: `,
                  `向买家 ${data.buyerGlobalMetaId || buyerDisplay} 就 ${title}（${data.pinId || ''}）签发还价特批单，价格设为：`,
                ),
              )
            }
            className={TK_BTN_SECONDARY}
          >
            {ct('Counter', '还价')}
          </button>
        </div>

        <div className="mt-1.5 flex justify-end">
          <button
            type="button"
            onClick={() =>
              dispatchSuiteComposerDraft(
                ct(
                  `Politely decline buyer ${data.buyerGlobalMetaId || buyerDisplay}'s offer on ${title}.`,
                  `礼貌回复买家 ${data.buyerGlobalMetaId || buyerDisplay}：暂不接受该价格。`,
                ),
              )
            }
            className={TK_CHIP_BTN}
          >
            {ct('Decline', '婉拒')}
          </button>
        </div>
      </div>
    );
  }

  // Mode 3 (`inquiry_sent`) & Mode 4 (`open_offer`)
  const isOpenOffer = data.kind === 'open_offer';
  const offerHeadline =
    data.proposedPriceMeMilli != null && data.proposedPriceMeMilli > 0
      ? formatMeDisplay(data.proposedPriceMeMilli)
      : formatNftPrice(data.offerPriceSats)?.split(' · ')[0] || ct('Sent', '已发送');

  return (
    <div
      data-nft-negotiate-card="true"
      data-nft-negotiate-kind={data.kind}
      className={`${TK_CARD_SHELL} ${className}`}
    >
      <div className="flex items-center gap-2.5">
        <NftSuiteThumb
          name={title}
          serial={serial}
          format={data.format}
          icon={data.icon}
          imgUrl={data.imgUrl}
          size="md"
          showSerialBadge
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="rounded-[6px] bg-[#0ea5e9]/15 px-1.5 py-0.5 text-[10px] font-bold text-[#0369a1] dark:text-[#38bdf8]">
              {isOpenOffer
                ? ct('On-chain Open Offer', '链上公开求购单')
                : ct('Inquiry Dispatched', '议价请求已发送')}
            </span>
          </div>
          <div className="mt-1 truncate text-[14px] font-bold text-[#1f2329] dark:text-[#f4f5f8]">
            {title}
          </div>
        </div>
      </div>

      <div className={`mt-2.5 flex flex-col gap-1.5 text-[11.5px] ${TK_INSET_BOX}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[#5b6472] dark:text-[#9aa3b2]">
            {isOpenOffer ? ct('Escrowed Bid', '求购出价') : ct('Proposed Offer', '期望成交价')}
          </span>
          <span className="font-bold tabular-nums text-[#9a7300] dark:text-[#ffdc51]">
            {offerHeadline}
          </span>
        </div>
        {data.originalPriceMeMilli != null && data.originalPriceMeMilli > 0 && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[#5b6472] dark:text-[#9aa3b2]">
              {ct('Seller Ask', '卖家挂牌价')}
            </span>
            <span className="tabular-nums text-[#1f2329] dark:text-[#f4f5f8]">
              {formatMeDisplay(data.originalPriceMeMilli)}
            </span>
          </div>
        )}
        {(data.offerPinId || data.txId || data.pinId) && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[#5b6472] dark:text-[#9aa3b2]">
              {data.offerPinId ? 'Offer Pin' : data.txId ? 'TxID' : 'Item Pin'}
            </span>
            <CopyShortHashButton value={(data.offerPinId || data.txId || data.pinId)!} />
          </div>
        )}
      </div>

      {isOpenOffer && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() =>
              dispatchSuiteComposerDraft(
                ct(
                  `Cancel my open offer (${data.offerPinId || data.txId || ''}) on ${title}.`,
                  `撤销我对 ${title} 的链上公开求购单（${data.offerPinId || data.txId || ''}）。`,
                ),
              )
            }
            className={TK_CHIP_BTN}
          >
            {ct('Cancel Offer', '撤销求购单')}
          </button>
        </div>
      )}
    </div>
  );
};

export default NftNegotiateCard;
