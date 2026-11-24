import React, { useMemo, useState } from 'react';
import { ct } from '../commerce/commerceTradeI18n';
import { shortAddress } from './nftCardIdentity';
import type { NftActionCardData } from './nftSuiteSyntax';
import {
  CopyShortHashButton,
  TK_BENTO_CELL,
  TK_BTN_PRIMARY,
  TK_BTN_SECONDARY,
  TK_CARD_SHELL,
  TK_INSET_BOX,
  dispatchSuiteComposerDraft,
} from './tokenSuiteUi';
import {
  NftProtocolBadge,
  NftSuiteThumb,
  NftVerifiedPill,
  resolveNftSuiteArtworkSources,
} from './nftSuiteUi';

export interface NftActionCardProps {
  data: NftActionCardData;
  className?: string;
}

export const NftActionCard: React.FC<NftActionCardProps> = ({ data, className = '' }) => {
  const serial = data.tokenIndex || (data.number != null ? String(data.number) : null);
  const title = data.name || `${ct('Digital Item', '数字商品')}${serial ? ` #${serial}` : ''}`;
  const sources = useMemo(
    () => resolveNftSuiteArtworkSources({ format: data.format, icon: data.icon, imgUrl: data.imgUrl }),
    [data.format, data.icon, data.imgUrl],
  );
  const [imgIdx, setImgIdx] = useState(0);

  if (data.kind === 'avatar') {
    const avatarInitial = (data.senderLabel || title || 'M').trim().slice(0, 2).toUpperCase();
    return (
      <div
        data-nft-action-card="true"
        data-nft-action-kind="avatar"
        className={`${TK_CARD_SHELL} ${className}`}
      >
        {/* Gold-Emerald Verified Avatar Ring Hero */}
        <div className="flex flex-col items-center rounded-[13px] bg-gradient-to-b from-[#ffdc51]/[0.14] via-transparent to-transparent px-3 pt-3 pb-2 dark:from-[#ffdc51]/[0.1]">
          <div className="relative">
            <div className="rounded-full bg-gradient-to-tr from-[#ffdc51] via-[#10b981] to-[#38bdf8] p-[3px] shadow-md">
              <div className="h-[74px] w-[74px] overflow-hidden rounded-full border-2 border-white bg-[#f2f4f7] dark:border-[#232529] dark:bg-[#1a1c20]">
                {imgIdx < sources.length ? (
                  <img
                    src={sources[imgIdx]}
                    alt={title}
                    onError={() => setImgIdx((n) => n + 1)}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center font-extrabold text-[#b48a00] dark:text-[#ffdc51]">
                    {avatarInitial}
                  </div>
                )}
              </div>
            </div>
            <span className="absolute -bottom-1 right-0 inline-flex items-center gap-0.5 rounded-full border-2 border-white bg-[#0f9d68] px-1.5 py-[1px] text-[9.5px] font-extrabold text-white shadow-sm dark:border-[#232529]">
              NFT ✓
            </span>
          </div>

          <div className="mt-2.5 text-center">
            <div className="text-[14.5px] font-extrabold text-[#1f2329] dark:text-[#f4f5f8]">
              {ct('Verified NFT Avatar Equipped', '链上认证头像已穿戴')}
            </div>
            <div className="mt-0.5 text-[11.5px] font-medium text-[#5b6472] dark:text-[#9aa3b2]">
              {title}
              {data.series ? ` · ${data.series}` : ''}
            </div>
          </div>
        </div>

        {/* Ledger */}
        <div className={`mt-2 flex flex-col gap-1.5 text-[11.5px] ${TK_INSET_BOX}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[#5b6472] dark:text-[#9aa3b2]">
              {ct('Protocol Path', '认证协议路径')}
            </span>
            <span className="font-mono text-[11px] font-bold text-[#0f9d68] dark:text-[#34d399]">
              {data.avatarPath || '/info/nftAvatar'}
            </span>
          </div>
          {data.pinId && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#5b6472] dark:text-[#9aa3b2]">MRC-721 Pin</span>
              <CopyShortHashButton value={data.pinId} />
            </div>
          )}
          {data.txId && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#5b6472] dark:text-[#9aa3b2]">TxID</span>
              <CopyShortHashButton value={data.txId} />
            </div>
          )}
        </div>

        {/* CTA */}
        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              dispatchSuiteComposerDraft(
                ct(
                  `Publish a Buzz showing off my new verified MRC-721 NFT avatar (${title})!`,
                  `发一条广场动态（Buzz），秀出我刚换上的链上认证数字藏品新头像（${title}）！`,
                ),
              )
            }
            className={TK_BTN_PRIMARY}
          >
            {ct('✦ Post Buzz with New Avatar', '✦ 发条动态秀出新头像')}
          </button>
        </div>
      </div>
    );
  }

  if (data.kind === 'mint') {
    return (
      <div
        data-nft-action-card="true"
        data-nft-action-kind="mint"
        className={`${TK_CARD_SHELL} ${className}`}
      >
        <div className="relative">
          <NftSuiteThumb
            name={title}
            serial={serial}
            format={data.format}
            icon={data.icon}
            imgUrl={data.imgUrl}
            size="hero-wide"
          />
          <span className="pointer-events-none absolute left-2 top-2 rounded-[7px] border border-[#ffdc51]/45 bg-slate-900/78 px-2 py-[2px] text-[10px] font-extrabold tracking-wide text-[#ffdc51] backdrop-blur-md">
            ✦ GENESIS MINT
          </span>
          {serial && (
            <span className="pointer-events-none absolute bottom-2 left-2 rounded-[7px] border border-white/15 bg-slate-900/75 px-2 py-[2px] font-mono text-[10.5px] font-bold text-white backdrop-blur-md">
              #{serial}
            </span>
          )}
          <span className="pointer-events-none absolute bottom-2 right-2 rounded-[7px] border border-white/15 bg-slate-900/75 px-2 py-[2px] text-[10px] font-semibold text-white backdrop-blur-md">
            MRC-721
          </span>
        </div>

        <div className="mt-2">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[14.5px] font-extrabold text-[#1f2329] dark:text-[#f4f5f8]">
              {title}
            </span>
            <NftVerifiedPill caVerified={data.caVerified} />
          </div>
          {data.series && (
            <div className="mt-0.5 truncate text-[11.5px] text-[#5b6472] dark:text-[#9aa3b2]">
              {data.series}
            </div>
          )}
        </div>

        <div className={`mt-2 flex flex-col gap-1.5 text-[11.5px] ${TK_INSET_BOX}`}>
          {data.pinId && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#5b6472] dark:text-[#9aa3b2]">
                {ct('Minted Pin', '铸造 Pin')}
              </span>
              <CopyShortHashButton value={data.pinId} />
            </div>
          )}
          {data.txId && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#5b6472] dark:text-[#9aa3b2]">TxID</span>
              <CopyShortHashButton value={data.txId} />
            </div>
          )}
        </div>

        <div className="mt-2.5 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              dispatchSuiteComposerDraft(
                ct(
                  `List my newly minted collectible ${title} (${data.pinId || ''}) for ME points sale.`,
                  `帮我把刚铸造成功的数字藏品 ${title}（${data.pinId || ''}）立即定价挂牌出售。`,
                ),
              )
            }
            className={TK_BTN_PRIMARY}
          >
            {ct('✦ Price & List Now', '✦ 立即定价挂牌出售')}
          </button>
          {data.pinId && (
            <button
              type="button"
              onClick={() =>
                dispatchSuiteComposerDraft(
                  ct(
                    `Set ${title} (nft://mrc721/${data.pinId}) as my verified on-chain avatar.`,
                    `把 ${title}（nft://mrc721/${data.pinId}）设为我的链上认证头像。`,
                  ),
                )
              }
              className={TK_BTN_SECONDARY}
            >
              {ct('Set Avatar', '设为头像')}
            </button>
          )}
        </div>
      </div>
    );
  }

  // Transfer receipt (`kind === 'transfer'`)
  const senderText =
    data.senderLabel ||
    (data.senderAddress ? shortAddress(data.senderAddress) : ct('My Wallet', '我的钱包'));
  const recipientText =
    data.recipientLabel ||
    (data.recipientAddress ? shortAddress(data.recipientAddress) : ct('Recipient', '接收方'));

  return (
    <div
      data-nft-action-card="true"
      data-nft-action-kind="transfer"
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
          <div className="truncate text-[14.5px] font-extrabold text-[#1f2329] dark:text-[#f4f5f8]">
            {ct('Collectible Transferred', '数字藏品已转出')}
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-[#5b6472] dark:text-[#9aa3b2]">
            {title}
            {data.series ? ` · ${data.series}` : ''}
          </div>
          <div className="mt-1 flex items-center gap-1">
            <NftProtocolBadge format={data.format} compact />
          </div>
        </div>
      </div>

      {/* Sender -> Recipient Flow */}
      <div className="mt-2.5 grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
        <div className={TK_BENTO_CELL}>
          <div className="text-[10px] font-medium text-[#8a94a6]">
            {ct('From', '转出方')}
          </div>
          <div className="mt-0.5 truncate font-mono text-[12px] font-bold text-[#1f2329] dark:text-[#f4f5f8]">
            {senderText}
          </div>
        </div>
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[#0ea5e9]/15 text-[11px] font-bold text-[#0369a1] dark:text-[#38bdf8]">
          →
        </div>
        <div className="min-w-0 rounded-[10px] border border-[#0f9d68]/25 bg-[#0f9d68]/[0.08] px-[10px] py-[8px] dark:border-[#34d399]/25 dark:bg-[#34d399]/[0.1]">
          <div className="text-[10px] font-semibold text-[#0f9d68] dark:text-[#34d399]">
            {ct('To Recipient', '接收方')}
          </div>
          <div className="mt-0.5 truncate font-mono text-[12px] font-bold text-[#0f9d68] dark:text-[#34d399]">
            {recipientText}
          </div>
        </div>
      </div>

      <div className={`mt-2 flex flex-col gap-1.5 text-[11.5px] ${TK_INSET_BOX}`}>
        {data.pinId && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[#5b6472] dark:text-[#9aa3b2]">Pin</span>
            <CopyShortHashButton value={data.pinId} />
          </div>
        )}
        {data.txId && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[#5b6472] dark:text-[#9aa3b2]">TxID</span>
            <CopyShortHashButton value={data.txId} />
          </div>
        )}
      </div>

      <div className="mt-2.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() =>
            dispatchSuiteComposerDraft(
              ct(
                `Send a private message notifying ${data.recipientGlobalMetaId || recipientText} that I transferred ${title} (TxID: ${data.txId || ''}).`,
                `发条加密私信通知好友 ${data.recipientGlobalMetaId || recipientText}：数字藏品 ${title} 已转出，请查收！`,
              ),
            )
          }
          className={TK_BTN_PRIMARY}
        >
          {ct('💬 Notify Friend via DM', '💬 私信通知好友查收')}
        </button>
      </div>
    </div>
  );
};

export default NftActionCard;
