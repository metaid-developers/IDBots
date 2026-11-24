import React, { useMemo, useState } from 'react';
import { parseMetafileUri } from '../cowork/A2AMessageItem';
import { ct } from '../commerce/commerceTradeI18n';
import type { NftCardFormat } from './nftCardSyntax';

/**
 * Shared artwork resolution & visual badges for the NFT / Digital Goods
 * card suite (`TK_CARD_SHELL` design system).
 */
export function resolveNftSuiteArtworkSources(input: {
  format?: NftCardFormat;
  icon?: string;
  imgUrl?: string;
}): string[] {
  const sources: string[] = [];
  if (input.format === 'metacontract' && input.icon) {
    const base = input.icon.trim().replace(/^metafile:\/\//i, '').split(/[?#]/)[0] ?? '';
    const fileId = base.replace(/\.[A-Za-z0-9]{1,8}$/, '');
    if (/^[0-9a-f]{64}$/i.test(fileId)) {
      sources.push(`https://metalet.space/metafile/compress/${fileId.toLowerCase()}`);
    }
  }
  if (input.imgUrl && !sources.includes(input.imgUrl)) {
    sources.push(input.imgUrl);
  }
  if (input.icon) {
    const parsed = parseMetafileUri(input.icon);
    if (parsed) {
      if (!sources.includes(parsed.sourceUrl)) sources.push(parsed.sourceUrl);
      if (!sources.includes(parsed.fallbackUrl)) sources.push(parsed.fallbackUrl);
    }
  }
  return sources;
}

export const NftSuiteThumb: React.FC<{
  name?: string;
  serial?: string | number | null;
  format?: NftCardFormat;
  icon?: string;
  imgUrl?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'hero-square' | 'hero-wide';
  showSerialBadge?: boolean;
  dimmed?: boolean;
}> = ({
  name,
  serial,
  format = 'mrc721',
  icon,
  imgUrl,
  size = 'md',
  showSerialBadge = false,
  dimmed = false,
}) => {
  const sources = useMemo(
    () => resolveNftSuiteArtworkSources({ format, icon, imgUrl }),
    [format, icon, imgUrl],
  );
  const [idx, setIdx] = useState(0);
  const initials = (name?.trim() || 'NFT').slice(0, 2).toUpperCase();

  const sizeClass =
    size === 'xs'
      ? 'h-[26px] w-[26px] rounded-[7px] text-[10px]'
      : size === 'sm'
        ? 'h-[42px] w-[42px] rounded-[10px] text-[12px]'
        : size === 'md'
          ? 'h-[52px] w-[52px] rounded-[11px] text-[14px]'
          : size === 'lg'
            ? 'h-[68px] w-[68px] rounded-[12px] text-[16px]'
            : size === 'hero-square'
              ? 'aspect-square max-h-[190px] w-full rounded-[12px] text-2xl'
              : 'aspect-[16/10] w-full rounded-[12px] text-2xl';

  return (
    <div
      className={`relative shrink-0 overflow-hidden bg-[#f2f4f7] shadow-[inset_0_0_0_1px_rgba(15,23,42,0.06)] dark:bg-white/[0.045] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] ${sizeClass} ${
        dimmed ? 'opacity-80' : ''
      }`}
    >
      {idx < sources.length ? (
        <img
          src={sources[idx]}
          alt={name || ct('Digital Item', '数字商品')}
          loading="lazy"
          onError={() => setIdx((n) => n + 1)}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[#ffdc51]/20 via-[#0ea5e9]/10 to-[#8b5cf6]/15 font-extrabold tracking-wide text-[#b48a00] dark:text-[#ffdc51]">
          {initials}
        </div>
      )}
      {showSerialBadge && serial !== undefined && serial !== null && String(serial) !== '' && (
        <span className="pointer-events-none absolute bottom-[3px] right-[3px] rounded-[5px] bg-slate-900/75 px-[4.5px] py-[1px] font-mono text-[9px] font-bold leading-[1.2] text-white backdrop-blur-sm">
          #{String(serial).replace(/^#+/, '')}
        </span>
      )}
    </div>
  );
};

export const NftFanStack: React.FC<{
  items: Array<{
    format?: NftCardFormat;
    icon?: string;
    imgUrl?: string;
    name?: string;
  }>;
  totalCount?: number;
}> = ({ items, totalCount }) => {
  const slice = items.slice(0, 4);
  const extra = totalCount !== undefined ? Math.max(0, totalCount - slice.length) : 0;

  if (slice.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center pl-1">
      {slice.map((item, i) => (
        <div
          key={`fan-${i}`}
          className={`rounded-[9px] border-2 border-white shadow-sm dark:border-[#232529] ${
            i > 0 ? '-ml-2.5' : ''
          }`}
        >
          <NftSuiteThumb
            format={item.format}
            icon={item.icon}
            imgUrl={item.imgUrl}
            name={item.name}
            size="xs"
          />
        </div>
      ))}
      {extra > 0 && (
        <span className="-ml-2 inline-flex h-[28px] min-w-[28px] items-center justify-center rounded-[9px] border-2 border-white bg-[#e8ecf2] px-1.5 font-mono text-[10px] font-bold text-[#5b6472] dark:border-[#232529] dark:bg-white/[0.1] dark:text-[#f4f5f8]">
          +{extra}
        </span>
      )}
    </div>
  );
};

export const NftProtocolBadge: React.FC<{
  format?: NftCardFormat;
  compact?: boolean;
}> = ({ format = 'mrc721', compact = false }) => {
  if (format === 'metacontract') {
    return (
      <span className="inline-flex items-center whitespace-nowrap rounded-[6px] border border-amber-500/30 bg-amber-500/[0.12] px-[6px] py-[1.5px] text-[10px] font-semibold leading-[1.3] text-[#b45309] dark:border-amber-400/30 dark:bg-amber-400/[0.13] dark:text-[#fbbf24]">
        {compact ? 'MetaContract' : 'MVC · MetaContract'}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-[6px] border border-[#0ea5e9]/30 bg-[#0ea5e9]/[0.12] px-[6px] py-[1.5px] text-[10px] font-semibold leading-[1.3] text-[#0369a1] dark:border-[#38bdf8]/30 dark:bg-[#38bdf8]/[0.14] dark:text-[#38bdf8]">
      {compact ? 'MRC-721' : 'MVC · MRC-721'}
    </span>
  );
};

export const NftVerifiedPill: React.FC<{
  caVerified?: boolean;
  labelOverride?: string;
}> = ({ caVerified, labelOverride }) => {
  if (!caVerified) return null;
  return (
    <span
      data-nft-verified="true"
      className="inline-flex items-center whitespace-nowrap rounded-[6px] border border-[#0f9d68]/25 bg-[#0f9d68]/[0.11] px-[6px] py-[1.5px] text-[10px] font-semibold leading-[1.3] text-[#0f9d68] dark:border-[#34d399]/28 dark:bg-[#34d399]/[0.13] dark:text-[#34d399]"
    >
      ✓ {labelOverride || ct('Verified', '官方认证')}
    </span>
  );
};
