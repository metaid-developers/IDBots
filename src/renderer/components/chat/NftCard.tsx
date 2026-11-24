/**
 * NftCard (Variant N1 — Gallery Bento Card) — an on-chain NFT / Digital Item
 * rendered as a standalone chat bubble card (MRC-721 primary, MetaContract
 * compatible), supporting assistant-left commerce mode, horizontal group
 * scroller (`NftCardGroup`), and user-right owner card (`userSide`).
 *
 * Preserves all pinned structural contracts:
 * - Outer artwork wrapper has exact `className="relative"` with `NftCardImage`
 *   followed immediately by `NftCardFormatTag` (`data-nft-format`), no `<img>`
 *   when artwork is missing, no `pt-0`, and no `items-start` on card/group.
 * - Fixed four-row slot order (`data-nft-row="series"` with right-aligned price,
 *   title + `#serial`, `data-nft-row="owner"` `h-4`, `data-nft-row="issuer"` `h-4`).
 * - Upgraded to unified `TK_CARD_SHELL` light/dark surfaces, N1 2-column Bento
 *   multi-rail price highlight, `#ffdc51` dark-ink primary CTA, and owner-side
 *   quick action chips when `userSide` is true.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckBadgeIcon, CheckIcon, DocumentDuplicateIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { parseMetafileUri } from '../cowork/A2AMessageItem';
import { useNftCardIdentity, shortAddress } from './nftCardIdentity';
import { useNftCardHeal } from './nftCardHeal';
import type { NftCardData } from './nftCardSyntax';
import { ct, formatCnyDisplay, formatMeDisplay } from '../commerce/commerceTradeI18n';
import { dispatchCommerceIntent } from '../commerce/commerceTradeEvents';
import {
  TK_BENTO_CELL,
  TK_BTN_PRIMARY,
  TK_BTN_SECONDARY,
  TK_CHIP_BTN,
  dispatchSuiteComposerDraft,
} from './tokenSuiteUi';

const ACTION_LABELS: Record<string, string> = {
  listed: 'LISTED',
  transferred: 'TRANSFERRED',
  sold: 'SOLD',
  bought: 'BOUGHT',
  escrow: 'ESCROW',
  delisted: 'DELISTED',
  minted: 'MINTED',
  selling: 'LISTED',
  info: 'ITEM',
};

const ACTION_BADGE_CLASS: Record<string, string> = {
  listed: 'bg-[#0f9d68]/15 text-[#0f9d68] dark:bg-[#34d399]/18 dark:text-[#34d399]',
  sold: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  bought: 'bg-[#0f9d68]/15 text-[#0f9d68] dark:bg-[#34d399]/18 dark:text-[#34d399]',
  transferred: 'bg-[#0ea5e9]/15 text-[#0369a1] dark:text-[#38bdf8]',
  escrow: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  delisted: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  minted: 'bg-[#0f9d68]/15 text-[#0f9d68] dark:bg-[#34d399]/18 dark:text-[#34d399]',
  selling: 'bg-[#0f9d68]/15 text-[#0f9d68] dark:bg-[#34d399]/18 dark:text-[#34d399]',
  info: 'bg-amber-500/15 text-[#9a7300] dark:bg-[#ffdc51]/18 dark:text-[#ffdc51]',
};

export const shortId = (id: string, head = 10, tail = 6): string =>
  id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;

export const formatNftPrice = (priceSats: number | undefined): string | null => {
  if (priceSats === undefined || priceSats === null) return null;
  const sats = `${priceSats.toLocaleString('en-US')} sats`;
  if (priceSats === 0) return sats;
  const space = priceSats / 1e8;
  const spaceText = space >= 0.01 ? space.toFixed(space >= 1000 ? 0 : 2) : space.toPrecision(2);
  return `${sats} · ${Number(spaceText).toString()} SPACE`;
};

/** The card's serial display: MetaContract tokenIndex, or MRC-721 mint number. */
export const nftCardSerial = (data: NftCardData): string | null => {
  if (data.tokenIndex) return data.tokenIndex;
  if (data.number != null) return String(data.number);
  return null;
};

const FORMAT_TAG_LABEL: Record<NftCardData['format'], string> = {
  mrc721: 'MRC-721',
  metacontract: 'MetaContract',
};

export interface NftCardArtwork {
  /** Ordered candidate <img> sources; empty when nothing renderable. */
  sources: string[];
  /** true when the payload carried no artwork reference at all. */
  missing: boolean;
}

export const metaletFileIdOf = (icon: string): string | null => {
  const base = icon.trim().replace(/^metafile:\/\//i, '').split(/[?#]/)[0] ?? '';
  const fileId = base.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  return /^[0-9a-f]{64}$/i.test(fileId) ? fileId.toLowerCase() : null;
};

export const metaletCompressUrlOf = (icon: string): string | null => {
  const fileId = metaletFileIdOf(icon);
  return fileId ? `https://metalet.space/metafile/compress/${fileId}` : null;
};

export const showpayOriginalUrlOf = (icon: string): string | null => {
  const fileId = metaletFileIdOf(icon);
  return fileId ? `https://showpay.oss-cn-beijing.aliyuncs.com/metaFile/original/${fileId}.png` : null;
};

export const resolveNftCardArtwork = (data: NftCardData, opts?: { large?: boolean }): NftCardArtwork => {
  const sources: string[] = [];
  if (data.format === 'metacontract' && data.icon) {
    if (opts?.large) {
      const original = showpayOriginalUrlOf(data.icon);
      if (original) sources.push(original);
    }
    const compress = metaletCompressUrlOf(data.icon);
    if (compress) sources.push(compress);
  }
  if (data.imgUrl && !sources.includes(data.imgUrl)) sources.push(data.imgUrl);
  if (data.icon) {
    const parsed = parseMetafileUri(data.icon);
    if (parsed) {
      if (!sources.includes(parsed.sourceUrl)) sources.push(parsed.sourceUrl);
      if (!sources.includes(parsed.fallbackUrl)) sources.push(parsed.fallbackUrl);
    }
  }
  return { sources, missing: sources.length === 0 };
};

const initialsOf = (data: NftCardData): string => {
  const base = data.name?.trim() || data.series?.trim() || 'DI';
  return base.slice(0, 2).toUpperCase();
};

const formatCardRowPrice = (data: NftCardData): string | null => {
  if (data.priceMeMilli != null && data.priceMeMilli > 0) {
    return formatMeDisplay(data.priceMeMilli);
  }
  if (data.priceTokens && data.priceTokens.length > 0) {
    const first = data.priceTokens[0];
    return `${first.amountDisplay} $${first.symbol}`;
  }
  if (data.priceCnyCents != null && data.priceCnyCents > 0) {
    return formatCnyDisplay(data.priceCnyCents);
  }
  const satsPrice = formatNftPrice(data.priceSats);
  return satsPrice ? satsPrice.split(' · ')[0] : null;
};

const copyTextToClipboard = (value: string): void => {
  if (!value || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
  void navigator.clipboard.writeText(value).catch(() => {});
};

const CopyButton: React.FC<{ value: string; label: string }> = ({ value, label }) => (
  <button
    type="button"
    onClick={(event) => {
      event.stopPropagation();
      copyTextToClipboard(value);
    }}
    className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[8px] text-current opacity-60 transition-opacity hover:opacity-100"
    title={`Copy ${label}`}
    aria-label={`Copy ${label}`}
  >
    <DocumentDuplicateIcon className="h-3 w-3" />
  </button>
);

const NftCardFormatTag: React.FC<{ format: NftCardData['format'] }> = ({ format }) => (
  <span
    data-nft-format={format}
    className={`pointer-events-none absolute bottom-2 right-2 rounded-[7px] px-2 py-[2px] text-[10px] font-semibold leading-tight shadow-sm backdrop-blur-md ${
      format === 'mrc721'
        ? 'border border-white/15 bg-slate-900/75 text-white'
        : 'border border-amber-300/30 bg-slate-900/75 text-amber-200'
    }`}
  >
    {FORMAT_TAG_LABEL[format]}
  </span>
);

const NftCardPlaceholder: React.FC<{ data: NftCardData; large?: boolean; compactSquare?: boolean }> = ({
  data,
  large,
  compactSquare,
}) => (
  <div
    className={`flex w-full items-center justify-center bg-gradient-to-br from-[#ffdc51]/20 via-[#0ea5e9]/10 to-[#8b5cf6]/15 dark:from-[#ffdc51]/20 dark:via-[#38bdf8]/12 dark:to-[#8b5cf6]/20 ${
      large
        ? 'min-h-[280px] text-4xl'
        : compactSquare
          ? 'aspect-square rounded-[12px] text-2xl'
          : 'aspect-[16/11] rounded-[12px] text-2xl'
    } font-extrabold tracking-wide text-[#b48a00] dark:text-[#ffdc51]`}
  >
    {initialsOf(data)}
  </div>
);

const NftCardImage: React.FC<{ data: NftCardData; large?: boolean; compactSquare?: boolean }> = ({
  data,
  large,
  compactSquare,
}) => {
  const artwork = useMemo(() => resolveNftCardArtwork(data, { large }), [data, large]);
  const [failedCount, setFailedCount] = useState(0);
  const exhausted = failedCount >= artwork.sources.length;

  if (artwork.missing || exhausted) {
    return <NftCardPlaceholder data={data} large={large} compactSquare={compactSquare} />;
  }
  const serial = nftCardSerial(data);
  const itemDefaultLabel = ct('Digital Item', '数字商品');
  return (
    <img
      src={artwork.sources[failedCount]}
      alt={data.name ? `${data.name}${serial ? ` #${serial}` : ''}` : `${itemDefaultLabel}${serial ? ` #${serial}` : ''}`}
      loading="lazy"
      className={`block w-full bg-[#f2f4f7] object-cover dark:bg-white/[0.045] ${
        large
          ? 'max-h-[60vh]'
          : compactSquare
            ? 'aspect-square rounded-[12px]'
            : 'aspect-[16/11] rounded-[12px]'
      }`}
      onError={() => setFailedCount((n) => n + 1)}
    />
  );
};

const ActionBadge: React.FC<{ action?: string }> = ({ action }) => {
  if (!action) return null;
  const label = ACTION_LABELS[action] ?? (action.length <= 10 ? action.toUpperCase() : null);
  if (!label) return null;
  return (
    <span
      className={`shrink-0 rounded-[6px] px-1.5 py-[1px] text-[10px] font-semibold leading-tight ${
        ACTION_BADGE_CLASS[action] ?? ACTION_BADGE_CLASS.info
      }`}
    >
      {label}
    </span>
  );
};

const IdentityAvatar: React.FC<{ name: string | null; avatarUrl?: string | null; className?: string }> = ({
  name,
  avatarUrl,
  className = 'h-4 w-4 text-[9px]',
}) => {
  const [failed, setFailed] = useState(false);
  const initial = (name || '?').trim().slice(0, 1).toUpperCase() || '?';
  if (avatarUrl && !failed) {
    return (
      <img
        src={avatarUrl}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className={`shrink-0 rounded-full bg-black/10 object-cover dark:bg-white/10 ${className}`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full bg-[#ffdc51]/25 font-bold text-[#9a7300] dark:bg-[#ffdc51]/20 dark:text-[#ffdc51] ${className}`}
    >
      {initial}
    </span>
  );
};

export const NftCardIdentityChip: React.FC<{
  address?: string;
  label?: string;
  className?: string;
  avatarClassName?: string;
}> = ({ address, label, className = '', avatarClassName }) => {
  const identity = useNftCardIdentity(address);
  const displayName = identity?.name || label || (address ? shortAddress(address) : null);
  if (!displayName) return null;
  return (
    <span
      data-nft-identity={address || displayName}
      title={address || undefined}
      className={`flex min-w-0 items-center gap-1 ${className}`}
    >
      <IdentityAvatar name={displayName} avatarUrl={identity?.avatarUrl ?? null} className={avatarClassName} />
      <span className="truncate font-medium text-[#1f2329] dark:text-[#f4f5f8]">{displayName}</span>
    </span>
  );
};

interface DetailField {
  label: string;
  value: string;
  mono?: boolean;
  copy?: boolean;
}

const buildDetailFields = (data: NftCardData): DetailField[] => {
  const fields: DetailField[] = [];
  if (data.name) fields.push({ label: 'Name', value: data.name });
  if (data.series) {
    fields.push({ label: data.format === 'mrc721' ? 'Collection' : 'Series', value: data.series });
  }
  if (data.format === 'mrc721') {
    if (data.number != null) fields.push({ label: 'Number', value: `#${data.number}`, mono: true });
    if (data.pinId) fields.push({ label: 'Pin id', value: data.pinId, mono: true, copy: true });
  } else {
    if (data.tokenIndex) fields.push({ label: 'Token index', value: `#${data.tokenIndex}`, mono: true, copy: true });
    if (data.genesis) fields.push({ label: 'Genesis', value: data.genesis, mono: true, copy: true });
    if (data.codehash) fields.push({ label: 'Codehash', value: data.codehash, mono: true, copy: true });
  }
  if (data.priceMeMilli != null && data.priceMeMilli > 0) {
    fields.push({ label: ct('ME Price', 'ME 价格'), value: formatMeDisplay(data.priceMeMilli) });
  }
  if (data.priceTokens && data.priceTokens.length > 0) {
    for (const tok of data.priceTokens) {
      fields.push({
        label: ct(`Token Price ($${tok.symbol})`, `代币价格 ($${tok.symbol})`),
        value: `${tok.amountDisplay} $${tok.symbol} (${tok.assetKey})`,
      });
    }
  }
  if (data.priceCnyCents != null && data.priceCnyCents > 0) {
    fields.push({ label: ct('CNY Reference', '人民币参考价'), value: formatCnyDisplay(data.priceCnyCents) });
  }
  const price = formatNftPrice(data.priceSats);
  if (price) fields.push({ label: 'Price', value: price });
  return fields;
};

const DetailIdentityRow: React.FC<{ label: string; address?: string; labelFallback?: string }> = ({
  label,
  address,
  labelFallback,
}) => {
  if (!address && !labelFallback) return null;
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-wide text-[#5b6472] dark:text-[#9aa3b2]">
        {label}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-[#1f2329] dark:text-[#f4f5f8]">
        <NftCardIdentityChip address={address} label={labelFallback} className="min-w-0 flex-1" />
        {address && (
          <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
            {shortAddress(address)}
            <CopyButton value={address} label={label.toLowerCase()} />
          </span>
        )}
      </div>
    </div>
  );
};

export const NftCardDetailModal: React.FC<{ data: NftCardData; onClose: () => void }> = ({ data, onClose }) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const serial = nftCardSerial(data);
  const itemDefaultLabel = ct('Digital Item', '数字商品');
  const title = data.name ? `${data.name}${serial ? ` #${serial}` : ''}` : `${itemDefaultLabel}${serial ? ` #${serial}` : ''}`;

  const content = (
    <div
      data-nft-card-detail="true"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`NFT detail: ${title}`}
    >
      <div
        className="flex max-h-[86vh] w-[min(94vw,640px)] flex-col overflow-hidden rounded-[20px] border border-slate-900/[0.09] bg-white text-[#1f2329] shadow-2xl dark:border-white/[0.1] dark:bg-[#232529] dark:text-[#f4f5f8]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-slate-900/[0.08] px-4 py-2.5 dark:border-white/[0.08]">
          <div className="flex min-w-0 items-center gap-2">
            <ActionBadge action={data.action ?? 'info'} />
            {data.caVerified === true && (
              <span
                data-nft-verified="true"
                className="inline-flex shrink-0 items-center gap-0.5 rounded-[6px] bg-[#0f9d68]/15 px-1.5 py-px text-[10px] font-semibold text-[#0f9d68] dark:text-[#34d399]"
              >
                <CheckBadgeIcon className="h-3 w-3" />
                {ct('Verified', '官方认证')}
              </span>
            )}
            <span className="truncate text-sm font-semibold">{title}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[8px] p-1 text-[#5b6472] transition-colors hover:bg-black/5 dark:text-[#9aa3b2] dark:hover:bg-white/10"
            aria-label="Close NFT detail"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-start overflow-y-auto sm:flex-row">
          <div className="relative w-full shrink-0 self-start sm:w-[46%]">
            <NftCardImage data={data} large />
            <NftCardFormatTag format={data.format} />
          </div>
          <div className="flex w-full min-w-0 flex-1 flex-col gap-3 px-4 py-2.5">
            <div className="flex flex-col gap-2">
              <DetailIdentityRow label="Owner" address={data.owner} labelFallback={data.ownerLabel} />
              {(data.issuer || data.issuerLabel) && (
                <DetailIdentityRow label="Issuer" address={data.issuer} labelFallback={data.issuerLabel} />
              )}
            </div>
            <div className="flex flex-col gap-2 border-t border-slate-900/[0.08] pt-3 dark:border-white/[0.08]">
              {buildDetailFields(data).map((field) => (
                <div key={field.label} className="min-w-0">
                  <div className="text-[10px] font-medium uppercase tracking-wide text-[#5b6472] dark:text-[#9aa3b2]">
                    {field.label}
                  </div>
                  <div
                    className={`flex gap-1 text-[12px] leading-4 ${
                      field.mono ? 'font-mono [overflow-wrap:anywhere]' : ''
                    }`}
                  >
                    <span className="min-w-0 break-all">{field.value}</span>
                    {field.copy && <CopyButton value={field.value} label={field.label.toLowerCase()} />}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return content;
  return createPortal(content, document.body);
};

export interface NftCardProps {
  data: NftCardData;
  className?: string;
  /** True when rendered inside horizontal `NftCardGroup` scroller. */
  groupMember?: boolean;
  /** True when rendered on the user's right-aligned message side. */
  userSide?: boolean;
}

const NftCard: React.FC<NftCardProps> = ({
  data,
  className = '',
  groupMember = false,
  userSide = false,
}) => {
  const [detailOpen, setDetailOpen] = useState(false);
  const [pinCopied, setPinCopied] = useState(false);
  const openDetail = useCallback(() => setDetailOpen(true), []);
  const closeDetail = useCallback(() => setDetailOpen(false), []);
  const healed = useNftCardHeal(data);

  const serial = nftCardSerial(healed);
  const itemDefaultLabel = ct('Digital Item', '数字商品');
  const title = healed.name || `${itemDefaultLabel}${serial ? ` #${serial}` : ''}`;
  const rowPrice = formatCardRowPrice(healed);
  const secondaryCny =
    healed.priceMeMilli != null &&
    healed.priceMeMilli > 0 &&
    healed.priceCnyCents != null &&
    healed.priceCnyCents > 0
      ? formatCnyDisplay(healed.priceCnyCents)
      : null;
  const identityLine = healed.format === 'mrc721' ? healed.pinId : healed.genesis;
  const ownerDisplayLabel = healed.ownerLabel || healed.sellerName;
  const tokenPrices = healed.priceTokens ?? [];

  const isListed = healed.action === 'selling' || healed.action === 'listed';
  const showBuyCapsule = Boolean(
    !userSide &&
      healed.pinId &&
      (healed.priceMeMilli != null || (tokenPrices.length === 0 && healed.action === 'selling')),
  );
  const showTokenCapsules = Boolean(!userSide && healed.pinId && tokenPrices.length > 0);
  const showNegotiateCapsule = Boolean(
    !userSide && healed.pinId && (healed.sellerGlobalMetaId || healed.action === 'selling'),
  );
  const showShopCapsule = Boolean(!userSide && healed.shopMetaAppPinId);
  const hasCommerceActions = showBuyCapsule || showTokenCapsules || showNegotiateCapsule || showShopCapsule;

  const showBentoPrices = Boolean(
    !groupMember &&
      !userSide &&
      (healed.priceMeMilli != null || tokenPrices.length > 0),
  );

  const copyPin = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const id = healed.pinId || healed.genesis || '';
      if (!id) return;
      copyTextToClipboard(id);
      setPinCopied(true);
      if (typeof window !== 'undefined') {
        window.setTimeout(() => setPinCopied(false), 1500);
      }
    },
    [healed.pinId, healed.genesis],
  );

  const outerWidthClass = groupMember
    ? 'w-[244px] max-w-full'
    : 'w-full max-w-[364px]';

  return (
    <>
      <div className={`${outerWidthClass} ${className}`}>
        <div className="flex h-full w-full flex-col overflow-hidden rounded-[18px] border border-slate-900/[0.09] bg-white p-[11px] text-[#1f2329] shadow-[0_4px_16px_rgba(15,23,42,0.06),0_1px_3px_rgba(15,23,42,0.04)] transition-shadow hover:shadow-[0_8px_24px_rgba(15,23,42,0.09)] dark:border-white/[0.1] dark:bg-[#232529] dark:text-[#f4f5f8] dark:shadow-[0_10px_26px_rgba(0,0,0,0.34),0_1px_2px_rgba(0,0,0,0.24)]">
          <button
            type="button"
            data-nft-card="true"
            data-nft-format={healed.format}
            data-nft-token-index={healed.tokenIndex}
            data-nft-pin-id={healed.pinId}
            data-nft-user-side={userSide ? 'true' : undefined}
            onClick={openDetail}
            title="View NFT details"
            aria-label={`View NFT details: ${title}`}
            className="flex flex-1 flex-col text-left"
          >
            {/* Outer div MUST retain exact className="relative" and keep NftCardFormatTag immediately after NftCardImage */}
            <div className="relative">
              <NftCardImage data={healed} compactSquare={groupMember} />
              <NftCardFormatTag format={healed.format} />
              {serial && (
                <span className="pointer-events-none absolute bottom-2 left-2 rounded-[7px] border border-white/15 bg-slate-900/72 px-2 py-[2px] font-mono text-[10.5px] font-bold leading-tight text-white backdrop-blur-md">
                  #{serial}
                </span>
              )}
              {isListed && !userSide && (
                <span className="pointer-events-none absolute right-2 top-2 inline-flex items-center gap-1 rounded-[7px] border border-emerald-400/35 bg-emerald-600/85 px-2 py-[2px] text-[10px] font-bold leading-tight text-white backdrop-blur-md">
                  ✦ {ct('Auto-Delivery', '在售 · AI秒发')}
                </span>
              )}
              {userSide && (
                <span className="pointer-events-none absolute right-2 top-2 inline-flex items-center gap-1 rounded-[7px] border border-[#ffdc51]/45 bg-slate-900/78 px-2 py-[2px] text-[10px] font-bold leading-tight text-[#ffdc51] backdrop-blur-md">
                  ✦ {ct('My Collectible', '我的持仓藏品')}
                </span>
              )}
            </div>

            {/* Fixed four-row slot structure (series -> title -> owner -> issuer) */}
            <div className="flex flex-col gap-[3px] px-2.5 pt-1.5 pb-2">
              <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight" data-nft-row="series">
                <ActionBadge action={healed.action} />
                {healed.caVerified === true && (
                  <span
                    data-nft-verified="true"
                    className="inline-flex shrink-0 items-center gap-0.5 rounded-[6px] border border-[#0f9d68]/25 bg-[#0f9d68]/[0.11] px-1.5 py-[1px] text-[10px] font-semibold leading-tight text-[#0f9d68] dark:border-[#34d399]/28 dark:bg-[#34d399]/[0.13] dark:text-[#34d399]"
                    title={ct('CA-Verified Official Collection', 'CA 官方认证系列')}
                  >
                    <CheckBadgeIcon className="h-2.5 w-2.5" />
                    {ct('Verified', '官方认证')}
                  </span>
                )}
                {healed.series ? (
                  <span className="truncate font-medium text-[#5b6472] dark:text-[#9aa3b2]">
                    {healed.series}
                  </span>
                ) : (
                  <span className="truncate font-mono text-[#5b6472] dark:text-[#9aa3b2]">
                    {identityLine ? shortId(identityLine, 8, 6) : itemDefaultLabel}
                  </span>
                )}
                {rowPrice && (
                  <span className="ml-auto flex shrink-0 items-baseline gap-1 font-bold tabular-nums text-[#9a7300] dark:text-[#ffdc51]">
                    <span>{rowPrice}</span>
                    {secondaryCny && (
                      <span className="text-[10px] font-normal text-[#5b6472] dark:text-[#9aa3b2]">
                        {secondaryCny}
                      </span>
                    )}
                  </span>
                )}
              </div>
              <div className="flex min-w-0 items-baseline gap-1.5 leading-tight">
                <span className="truncate text-[14.5px] font-bold tracking-[-0.01em] text-[#1f2329] dark:text-[#f4f5f8]">
                  {title}
                </span>
                {serial && (
                  <span className="shrink-0 font-mono text-[11.5px] text-[#5b6472] dark:text-[#9aa3b2]">
                    #{serial}
                  </span>
                )}
              </div>
              <div
                data-nft-row="owner"
                className="flex h-4 min-w-0 items-center gap-1.5 text-[11px] leading-tight text-[#5b6472] dark:text-[#9aa3b2]"
              >
                <span className="shrink-0 opacity-75">Owner</span>
                {healed.owner || ownerDisplayLabel ? (
                  <div className="flex min-w-0 flex-1 items-center gap-1">
                    {healed.sellerOnline === true && (
                      <span
                        data-seller-online="true"
                        title={ct('Seller Online', '卖家在线')}
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#10b981]"
                      />
                    )}
                    <NftCardIdentityChip
                      address={healed.owner}
                      label={ownerDisplayLabel}
                      className="min-w-0 flex-1"
                      avatarClassName="h-3.5 w-3.5 text-[8px]"
                    />
                  </div>
                ) : (
                  <span className="opacity-70">—</span>
                )}
              </div>
              <div
                data-nft-row="issuer"
                className="flex h-4 min-w-0 items-center gap-1.5 text-[11px] leading-tight text-[#5b6472] dark:text-[#9aa3b2]"
              >
                <span className="shrink-0 opacity-75">Issuer</span>
                {healed.issuer || healed.issuerLabel ? (
                  <NftCardIdentityChip
                    address={healed.issuer}
                    label={healed.issuerLabel}
                    className="min-w-0 flex-1"
                    avatarClassName="h-3.5 w-3.5 text-[8px]"
                  />
                ) : (
                  <span className="opacity-70">—</span>
                )}
              </div>
            </div>
          </button>

          {/* N1 2-Column Bento Price Highlight for standalone commerce listings */}
          {showBentoPrices && (
            <div className="mt-1 grid grid-cols-2 gap-[6px] px-1">
              <div className={`${TK_BENTO_CELL} border border-[#b48a00]/20 bg-[#ffdc51]/[0.1] dark:border-[#ffdc51]/20 dark:bg-[#ffdc51]/[0.07]`}>
                <div className="text-[10px] font-medium text-[#8a94a6]">
                  {ct('ME Escrow Price', 'ME 积分担保一口价')}
                </div>
                <div className="mt-0.5 truncate text-[15px] font-extrabold tabular-nums text-[#1f2329] dark:text-[#f4f5f8]">
                  {healed.priceMeMilli != null && healed.priceMeMilli > 0
                    ? formatMeDisplay(healed.priceMeMilli)
                    : ct('Ask Quote', '私聊询价')}
                </div>
                <div className="mt-0.5 truncate text-[10.5px] tabular-nums text-[#5b6472] dark:text-[#9aa3b2]">
                  {secondaryCny ? `≈ ${secondaryCny}` : ct('Escrow Protected', '担保锁单自动秒发')}
                </div>
              </div>
              <div className={TK_BENTO_CELL}>
                <div className="text-[10px] font-medium text-[#8a94a6]">
                  {tokenPrices.length > 0
                    ? ct('Token Direct Swap', '支持代币换物')
                    : ct('Fulfillment Mode', '交割方式')}
                </div>
                <div className="mt-0.5 truncate text-[13.5px] font-bold tabular-nums text-[#1f2329] dark:text-[#f4f5f8]">
                  {tokenPrices.length > 0
                    ? `${tokenPrices[0].amountDisplay} $${tokenPrices[0].symbol}`
                    : ct('⚡ AI 24h Auto', '⚡ AI 24h 秒发')}
                </div>
                <div className="mt-0.5 truncate text-[10.5px] text-[#5b6472] dark:text-[#9aa3b2]">
                  {tokenPrices.length > 0
                    ? tokenPrices[0].assetKey.startsWith('mrc20:')
                      ? 'BTC · MRC-20'
                      : 'MVC · FT'
                    : healed.sellerOnline
                      ? ct('● Seller Bot Online', '● 卖家分身在线')
                      : ct('On-chain Settlement', '链上即时交割')}
                </div>
              </div>
            </div>
          )}

          {/* Buyer Commerce Actions */}
          {hasCommerceActions && (
            <div
              data-nft-commerce-actions="true"
              className="mt-2 flex flex-col gap-1.5 border-t border-slate-900/[0.06] px-1 pt-2 dark:border-white/[0.07]"
            >
              {(showBuyCapsule || showTokenCapsules) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {showBuyCapsule && healed.pinId && (
                    <button
                      type="button"
                      data-nft-action="buy-me"
                      onClick={(e) => {
                        e.stopPropagation();
                        dispatchCommerceIntent({
                          type: 'buy_with_me',
                          itemPinId: healed.pinId!,
                          itemName: healed.name,
                          series: healed.series,
                          priceMeMilli: healed.priceMeMilli,
                          priceCnyCents: healed.priceCnyCents,
                          priceSats: healed.priceSats,
                          sellerAddress: healed.owner,
                          sellerGlobalMetaId: healed.sellerGlobalMetaId,
                          sellerName: ownerDisplayLabel,
                          shopMetaAppPinId: healed.shopMetaAppPinId,
                          icon: healed.icon,
                          imgUrl: healed.imgUrl,
                        });
                      }}
                      className={TK_BTN_PRIMARY}
                    >
                      {ct('✦ Buy with ME', '✦ 用 ME 购买')}
                    </button>
                  )}
                  {showTokenCapsules &&
                    healed.pinId &&
                    tokenPrices.map((tok) => (
                      <button
                        key={tok.assetKey}
                        type="button"
                        data-nft-action="buy-token"
                        data-asset-key={tok.assetKey}
                        onClick={(e) => {
                          e.stopPropagation();
                          dispatchCommerceIntent({
                            type: 'buy_with_token',
                            itemPinId: healed.pinId!,
                            paymentAssetKey: tok.assetKey,
                            tokenSymbol: tok.symbol,
                            tokenAmountDisplay: tok.amountDisplay,
                            tokenAmountBase: tok.amountBase,
                            tokenChain: tok.chain,
                            sellerReceiveAddress: tok.sellerReceiveAddress,
                            itemName: healed.name,
                            series: healed.series,
                            priceMeMilli: healed.priceMeMilli,
                            priceCnyCents: healed.priceCnyCents,
                            sellerAddress: healed.owner,
                            sellerGlobalMetaId: healed.sellerGlobalMetaId,
                            sellerName: ownerDisplayLabel,
                            shopMetaAppPinId: healed.shopMetaAppPinId,
                          });
                        }}
                        title={`${tok.amountDisplay} $${tok.symbol} (${tok.assetKey})`}
                        className={showBuyCapsule ? TK_BTN_SECONDARY : TK_BTN_PRIMARY}
                      >
                        {`🪙 ${tok.amountDisplay} $${tok.symbol}`}
                      </button>
                    ))}
                </div>
              )}

              {(showNegotiateCapsule || showShopCapsule || identityLine) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {showNegotiateCapsule && healed.pinId && (
                    <button
                      type="button"
                      data-nft-action="negotiate"
                      onClick={(e) => {
                        e.stopPropagation();
                        dispatchCommerceIntent({
                          type: 'negotiate',
                          itemPinId: healed.pinId!,
                          itemName: healed.name,
                          series: healed.series,
                          sellerAddress: healed.owner,
                          sellerGlobalMetaId: healed.sellerGlobalMetaId,
                          sellerName: ownerDisplayLabel,
                          priceMeMilli: healed.priceMeMilli,
                        });
                      }}
                      className={TK_CHIP_BTN}
                    >
                      {ct('💬 Negotiate', '💬 AI 议价')}
                    </button>
                  )}
                  {showShopCapsule && healed.shopMetaAppPinId && (
                    <button
                      type="button"
                      data-nft-action="visit-shop"
                      onClick={(e) => {
                        e.stopPropagation();
                        dispatchCommerceIntent({
                          type: 'visit_shop',
                          shopMetaAppPinId: healed.shopMetaAppPinId!,
                          sellerGlobalMetaId: healed.sellerGlobalMetaId,
                          sellerName: ownerDisplayLabel,
                        });
                      }}
                      className={TK_CHIP_BTN}
                    >
                      {ct('🏪 Visit Shop', '🏪 逛店铺')}
                    </button>
                  )}
                  {identityLine && !groupMember && (
                    <button
                      type="button"
                      onClick={copyPin}
                      className={`${TK_CHIP_BTN} ml-auto`}
                    >
                      {pinCopied ? (
                        <>
                          <CheckIcon className="h-3 w-3 text-[#0f9d68] dark:text-[#34d399]" />
                          {ct('Copied', '已复制')}
                        </>
                      ) : (
                        <>
                          <DocumentDuplicateIcon className="h-3 w-3" />
                          {healed.format === 'mrc721' ? ct('Copy Pin', '复制 Pin') : ct('Copy ID', '复制 ID')}
                        </>
                      )}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* User-Side Right-Aligned Owner Quick Actions */}
          {userSide && (
            <div
              data-nft-user-actions="true"
              className="mt-2 flex flex-col gap-1.5 border-t border-slate-900/[0.06] px-1 pt-2 dark:border-white/[0.07]"
            >
              <div className="flex items-center gap-1.5">
                {healed.format === 'mrc721' && healed.pinId ? (
                  <button
                    type="button"
                    data-nft-user-action="list"
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatchSuiteComposerDraft(
                        ct(
                          `Help me price and list my MRC-721 item ${title} (Pin: ${healed.pinId}) for ME points sale.`,
                          `帮我给这件数字藏品 ${title}（Pin: ${healed.pinId}）参考地板价挂牌出售。`,
                        ),
                      );
                    }}
                    className={TK_BTN_PRIMARY}
                  >
                    {ct('✦ List for Sale', '✦ 挂牌出售')}
                  </button>
                ) : (
                  <button
                    type="button"
                    data-nft-user-action="upgrade"
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatchSuiteComposerDraft(
                        ct(
                          `Upgrade my legacy MetaContract NFT ${title} (${healed.genesis || ''} #${healed.tokenIndex || ''}) 1:1 to MRC-721 via official swap station.`,
                          `帮我把这件旧版 MetaContract 藏品 ${title}（#${healed.tokenIndex || ''}）通过官方兑换站 1:1 免费升级为新版 MRC-721。`,
                        ),
                      );
                    }}
                    className={TK_BTN_PRIMARY}
                  >
                    {ct('✦ Free 1:1 Upgrade', '✦ 1:1 免费升级')}
                  </button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {healed.format === 'mrc721' && healed.pinId && (
                  <button
                    type="button"
                    data-nft-user-action="avatar"
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatchSuiteComposerDraft(
                        ct(
                          `Set my MRC-721 NFT ${title} (nft://mrc721/${healed.pinId}) as my verified on-chain avatar.`,
                          `把这件藏品 ${title}（nft://mrc721/${healed.pinId}）设为我的链上认证头像。`,
                        ),
                      );
                    }}
                    className={TK_CHIP_BTN}
                  >
                    {ct('Set Verified Avatar', '设为认证头像')}
                  </button>
                )}
                <button
                  type="button"
                  data-nft-user-action="transfer"
                  onClick={(e) => {
                    e.stopPropagation();
                    const ref = healed.pinId || `${healed.genesis || ''} #${healed.tokenIndex || ''}`;
                    dispatchSuiteComposerDraft(
                      ct(
                        `Transfer my NFT ${title} (${ref}) to a friend: `,
                        `帮我把这件藏品 ${title}（${ref}）转赠给好友：`,
                      ),
                    );
                  }}
                  className={TK_CHIP_BTN}
                >
                  {ct('Transfer / Gift', '转赠好友')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      {detailOpen && <NftCardDetailModal data={healed} onClose={closeDetail} />}
    </>
  );
};

const cardKeyOf = (data: NftCardData, index: number): string =>
  data.pinId || (data.genesis && data.tokenIndex ? `${data.genesis}:${data.tokenIndex}` : `card-${index}`);

/**
 * Side-by-side horizontal scroller for >=2 adjacent NFT cards (`nft-card-group`).
 * Preserves `items-stretch` + `overflow-x-auto` and never uses `items-start`.
 */
export const NftCardGroup: React.FC<{
  cards: NftCardData[];
  className?: string;
  userSide?: boolean;
}> = ({ cards, className = '', userSide = false }) => {
  if (!cards.length) return null;
  return (
    <div data-nft-card-group="true" className={`flex items-stretch gap-2.5 overflow-x-auto pb-1.5 ${className}`}>
      {cards.map((card, index) => (
        <NftCard
          key={cardKeyOf(card, index)}
          data={card}
          groupMember
          userSide={userSide}
          className="shrink-0"
        />
      ))}
    </div>
  );
};

export default NftCard;
