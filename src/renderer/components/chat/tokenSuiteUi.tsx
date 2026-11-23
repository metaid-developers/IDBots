import React, { useCallback, useState } from 'react';
import { CheckIcon, DocumentDuplicateIcon } from '@heroicons/react/24/outline';
import { ct } from '../commerce/commerceTradeI18n';
import {
  formatFtAssetBadge,
  type FtAssetChain,
  type FtAssetStandard,
  type FtCardRail,
} from './ftCardSyntax';

/**
 * Shared design-system tokens & primitives matching approved S1/D1 TokenCard:
 * - Outer shell: 18px radius (16px compact), 13px padding, white / #232529 surface
 * - Inset modules: 10px/11px radius, #f2f4f7 / white/[0.045]
 * - Primary CTA: #ffdc51 fill with #24210c / text-claude-accentInk dark ink (NEVER white)
 * - Tabular numerals on all prices, balances, and progress counters
 */
export const TK_CARD_SHELL =
  'w-full max-w-[364px] overflow-hidden rounded-[18px] border border-slate-900/[0.09] bg-white p-[13px] text-[#1f2329] shadow-[0_4px_16px_rgba(15,23,42,0.06),0_1px_3px_rgba(15,23,42,0.04)] dark:border-white/[0.1] dark:bg-[#232529] dark:text-[#f4f5f8] dark:shadow-[0_10px_26px_rgba(0,0,0,0.34),0_1px_2px_rgba(0,0,0,0.24)]';

export const TK_CARD_COMPACT_SHELL =
  'w-full max-w-[364px] overflow-hidden rounded-[16px] border border-slate-900/[0.09] bg-white p-[12px] text-[#1f2329] shadow-[0_4px_16px_rgba(15,23,42,0.06),0_1px_3px_rgba(15,23,42,0.04)] dark:border-white/[0.1] dark:bg-[#232529] dark:text-[#f4f5f8] dark:shadow-[0_10px_26px_rgba(0,0,0,0.34),0_1px_2px_rgba(0,0,0,0.24)]';

export const TK_INSET_BOX =
  'rounded-[11px] bg-[#f2f4f7] px-[10px] py-[8px] dark:bg-white/[0.045]';

export const TK_BENTO_CELL =
  'min-w-0 rounded-[10px] bg-[#f2f4f7] px-[10px] py-[8px] dark:bg-white/[0.045]';

export const TK_BTN_PRIMARY =
  'min-w-0 flex-1 truncate rounded-[10px] bg-[#ffdc51] px-[10px] py-[8px] text-center text-[12px] font-bold text-[#24210c] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)] transition hover:bg-[#ffe474] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50';

export const TK_BTN_SECONDARY =
  'shrink-0 rounded-[10px] border border-slate-900/[0.09] bg-[#f2f4f7] px-[10px] py-[8px] text-center text-[12px] font-semibold text-[#1f2329] transition hover:bg-[#e8ecf2] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.1] dark:bg-white/[0.045] dark:text-[#f4f5f8] dark:hover:bg-white/[0.08]';

export const TK_CHIP_BTN =
  'inline-flex items-center gap-1 rounded-full border border-slate-900/[0.09] bg-[#f2f4f7] px-[9px] py-[4.5px] text-[11px] font-semibold text-[#5b6472] transition hover:border-[#b48a00]/40 hover:text-[#1f2329] active:scale-[0.97] dark:border-white/[0.1] dark:bg-white/[0.045] dark:text-[#9aa3b2] dark:hover:border-[#ffdc51]/40 dark:hover:text-[#f4f5f8]';

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #f59e0b 0%, #ea580c 100%)',
  'linear-gradient(135deg, #0ea5e9 0%, #2563eb 100%)',
  'linear-gradient(135deg, #10b981 0%, #059669 100%)',
  'linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%)',
];

export function pickSuiteAvatarGradient(symbol: string, chain?: FtAssetChain | 'dual'): string {
  if (chain === 'dual') return 'linear-gradient(135deg, #f59e0b 0%, #0ea5e9 100%)';
  if (chain === 'btc') return 'linear-gradient(135deg, #f7931a 0%, #d97706 100%)';
  if (chain === 'mvc') return 'linear-gradient(135deg, #0ea5e9 0%, #2563eb 100%)';
  let hash = 0;
  const upper = symbol.toUpperCase();
  for (let i = 0; i < upper.length; i += 1) {
    hash = (hash * 31 + upper.charCodeAt(i)) >>> 0;
  }
  return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
}

export const SuiteTokenAvatar: React.FC<{
  symbol: string;
  chain?: FtAssetChain | 'dual';
  size?: 'sm' | 'md';
  glyphOverride?: string;
}> = ({ symbol, chain = 'btc', size = 'md', glyphOverride }) => {
  const glyph = glyphOverride || (symbol.trim().replace(/^\$+/, '').charAt(0) || 'T').toUpperCase();
  const bg = pickSuiteAvatarGradient(symbol, chain);
  const dimClass = size === 'sm' ? 'h-[30px] w-[30px] rounded-[9px] text-[11.5px]' : 'h-[36px] w-[36px] rounded-[11px] text-[13px]';
  const pipText = chain === 'btc' ? '₿' : chain === 'mvc' ? 'MVC' : chain === 'doge' ? 'Ð' : null;
  const pipBg = chain === 'btc' ? 'bg-[#f7931a]' : chain === 'mvc' ? 'bg-[#0284c7]' : 'bg-[#ca8a04]';

  return (
    <div
      style={{ background: bg }}
      className={`relative grid shrink-0 place-items-center font-extrabold text-white shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)] ${dimClass}`}
    >
      {glyph}
      {pipText && (
        <span
          className={`absolute -bottom-[3px] -right-[3px] inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full border-[1.5px] border-white px-[3.5px] text-[8.5px] font-extrabold leading-none text-white dark:border-[#232529] ${pipBg}`}
        >
          {pipText}
        </span>
      )}
    </div>
  );
};

export const ChainStandardBadge: React.FC<{
  chain: FtAssetChain;
  standard: FtAssetStandard;
  compact?: boolean;
}> = ({ chain, standard, compact }) => {
  if (chain === 'mvc' || standard === 'mvc-ft') {
    const label =
      standard === 'native'
        ? 'MVC · SPACE'
        : compact
          ? ct('MVC·Contract', 'MVC·合约')
          : 'MVC · MetaContract';
    return (
      <span className="inline-flex items-center whitespace-nowrap rounded-[6px] border border-[#0ea5e9]/30 bg-[#0ea5e9]/[0.12] px-[6.5px] py-[2px] text-[10.5px] font-semibold leading-[1.3] text-[#0369a1] dark:border-[#38bdf8]/30 dark:bg-[#38bdf8]/[0.14] dark:text-[#38bdf8]">
        {label}
      </span>
    );
  }
  if (chain === 'doge') {
    return (
      <span className="inline-flex items-center whitespace-nowrap rounded-[6px] border border-amber-500/30 bg-amber-500/[0.12] px-[6.5px] py-[2px] text-[10.5px] font-semibold leading-[1.3] text-[#b45309] dark:text-[#fbbf24]">
        DOGE · Native
      </span>
    );
  }
  const label =
    standard === 'native'
      ? 'BTC · Native'
      : standard === 'idcoin'
        ? compact
          ? 'BTC·ID-Coin'
          : 'BTC · ID-Coin'
        : compact
          ? 'BTC·MRC-20'
          : 'BTC · MRC-20';
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-[6px] border border-[#f7931a]/30 bg-[#f7931a]/[0.13] px-[6.5px] py-[2px] text-[10.5px] font-semibold leading-[1.3] text-[#c26200] dark:border-[#f7931a]/32 dark:bg-[#f7931a]/[0.15] dark:text-[#fb923c]">
      {label}
    </span>
  );
};

export const RailVenueBadge: React.FC<{
  rail: FtCardRail;
  autoFulfill?: boolean;
  compact?: boolean;
}> = ({ rail, autoFulfill, compact }) => {
  if (rail === 'me-escrow') {
    const label = compact
      ? ct('✦ ME Points', '✦ ME 积分')
      : autoFulfill
        ? ct('✦ ME Points Trade · AI Auto-Delivery', '✦ ME 积分交易 · AI 自动发币')
        : ct('✦ ME Points Trade', '✦ ME 积分交易');
    return (
      <span className="inline-flex items-center whitespace-nowrap rounded-[6px] border border-[#8b5cf6]/30 bg-[#8b5cf6]/[0.12] px-[6.5px] py-[2px] text-[10.5px] font-semibold leading-[1.3] text-[#6d28d9] dark:border-[#a78bfa]/32 dark:bg-[#a78bfa]/[0.15] dark:text-[#c4b5fd]">
        {label}
      </span>
    );
  }
  if (rail === 'btc-psbt') {
    const label = compact ? 'PSBT' : 'metaid.market · PSBT';
    return (
      <span className="inline-flex items-center whitespace-nowrap rounded-[6px] border border-[#f7931a]/30 bg-[#f7931a]/[0.13] px-[6.5px] py-[2px] text-[10.5px] font-semibold leading-[1.3] text-[#c26200] dark:border-[#f7931a]/32 dark:bg-[#f7931a]/[0.15] dark:text-[#fb923c]">
        {label}
      </span>
    );
  }
  if (rail === 'mvc-swap') {
    const label = compact ? 'MVCSwap' : ct('MVC · MVCSwap Pool', 'MVC · MVCSwap 闪兑');
    return (
      <span className="inline-flex items-center whitespace-nowrap rounded-[6px] border border-slate-900/[0.09] bg-[#e8ecf2] px-[6.5px] py-[2px] text-[10.5px] font-semibold leading-[1.3] text-[#5b6472] dark:border-white/[0.1] dark:bg-white/[0.08] dark:text-[#9aa3b2]">
        {label}
      </span>
    );
  }
  const label = compact ? 'TokenSell' : ct('MVC · TokenSell Contract', 'MVC · 链上合约挂单');
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-[6px] border border-[#0ea5e9]/30 bg-[#0ea5e9]/[0.12] px-[6.5px] py-[2px] text-[10.5px] font-semibold leading-[1.3] text-[#0369a1] dark:border-[#38bdf8]/30 dark:bg-[#38bdf8]/[0.14] dark:text-[#38bdf8]">
      {label}
    </span>
  );
};

export const VerifyOrIdBadge: React.FC<{
  caVerified?: boolean;
  assetKey?: string;
}> = ({ caVerified, assetKey }) => {
  if (caVerified) {
    return (
      <span
        data-ft-verified="true"
        className="inline-flex items-center whitespace-nowrap rounded-[6px] border border-[#0f9d68]/25 bg-[#0f9d68]/[0.11] px-[6.5px] py-[2px] text-[10.5px] font-semibold leading-[1.3] text-[#0f9d68] dark:border-[#34d399]/28 dark:bg-[#34d399]/[0.13] dark:text-[#34d399]"
      >
        ✓ {ct('Verified', '已认证')}
      </span>
    );
  }
  const badge = formatFtAssetBadge(assetKey || '');
  return (
    <span
      data-ft-verified="false"
      title={assetKey}
      className="inline-flex items-center whitespace-nowrap rounded-[6px] border border-amber-500/32 bg-amber-500/[0.12] px-[6.5px] py-[2px] font-mono text-[10.5px] font-semibold leading-[1.3] text-[#b45309] dark:border-amber-400/32 dark:bg-amber-400/[0.12] dark:text-[#fbbf24]"
    >
      {badge}
    </span>
  );
};

export const CopyShortHashButton: React.FC<{
  value: string;
  prefix?: string;
}> = ({ value, prefix = '' }) => {
  const [copied, setCopied] = useState(false);
  const short =
    value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;

  const onCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }
    },
    [value],
  );

  return (
    <button
      type="button"
      onClick={onCopy}
      title={value}
      className="inline-flex items-center gap-1 font-mono text-[11.5px] font-semibold text-[#1f2329] hover:opacity-80 dark:text-[#f4f5f8]"
    >
      <span>
        {prefix}
        {short}
      </span>
      {copied ? (
        <CheckIcon className="h-3.5 w-3.5 text-[#0f9d68] dark:text-[#34d399]" />
      ) : (
        <DocumentDuplicateIcon className="h-3.5 w-3.5 text-[#8a94a6]" />
      )}
    </button>
  );
};

/**
 * Dispatches a follow-up prompt draft into the active chat input across Studio,
 * Desktop Cowork, and Cloud Mobile.
 */
export function dispatchSuiteComposerDraft(text: string): void {
  if (typeof window === 'undefined' || !text.trim()) return;
  window.dispatchEvent(new CustomEvent('cowork:focus-input', { detail: { text } }));
}
