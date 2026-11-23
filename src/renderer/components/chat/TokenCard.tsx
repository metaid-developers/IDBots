import React, { useCallback, useMemo, useState } from 'react';
import { CheckIcon, DocumentDuplicateIcon } from '@heroicons/react/24/outline';
import { parseMetafileUri } from '../cowork/A2AMessageItem';
import { metaletCompressUrlOf } from './NftCard';
import {
  deriveChangeDir,
  formatTokenAssetShortId,
  formatTokenStandardLabel,
  type TokenCardData,
  type TokenCardQuickAction,
} from './tokenCardSyntax';
import { ct } from '../commerce/commerceTradeI18n';
import { i18nService } from '../../services/i18n';

export interface TokenCardProps {
  data: TokenCardData;
}

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #f59e0b 0%, #ea580c 100%)',
  'linear-gradient(135deg, #06b6d4 0%, #2563eb 100%)',
  'linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%)',
  'linear-gradient(135deg, #10b981 0%, #059669 100%)',
  'linear-gradient(135deg, #f97316 0%, #db2777 100%)',
  'linear-gradient(135deg, #3b82f6 0%, #4f46e5 100%)',
];

function pickAvatarGradient(symbol: string, chain: TokenCardData['chain']): string {
  const upper = symbol.toUpperCase();
  if (upper === 'BTC') return 'linear-gradient(135deg, #f7931a 0%, #ea580c 100%)';
  if (upper === 'SPACE' || upper === 'MVC') return 'linear-gradient(135deg, #06b6d4 0%, #2563eb 100%)';
  if (upper === 'DOGE') return 'linear-gradient(135deg, #eab308 0%, #ca8a04 100%)';
  if (upper === 'METAID') return 'linear-gradient(135deg, #f59e0b 0%, #ea580c 100%)';
  let hash = chain.charCodeAt(0) || 0;
  for (let i = 0; i < upper.length; i += 1) {
    hash = (hash * 31 + upper.charCodeAt(i)) >>> 0;
  }
  return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
}

export function resolveTokenCardIconSources(data: Pick<TokenCardData, 'icon' | 'standard'>): string[] {
  const sources: string[] = [];
  if (!data.icon) return sources;

  if (data.standard === 'mvc-ft') {
    const compress = metaletCompressUrlOf(data.icon);
    if (compress && !sources.includes(compress)) {
      sources.push(compress);
    }
  }

  if (/^https:\/\//i.test(data.icon)) {
    sources.push(data.icon);
    return sources;
  }

  const parsed = parseMetafileUri(data.icon);
  if (parsed) {
    if (!sources.includes(parsed.sourceUrl)) sources.push(parsed.sourceUrl);
    if (!sources.includes(parsed.fallbackUrl)) sources.push(parsed.fallbackUrl);
  }

  const compressFallback = metaletCompressUrlOf(data.icon);
  if (compressFallback && !sources.includes(compressFallback)) {
    sources.push(compressFallback);
  }

  return sources;
}

function formatCompactLocaleUsd(usd: number | undefined): string | undefined {
  if (usd === undefined || !Number.isFinite(usd) || usd <= 0) return undefined;
  const isZh = i18nService.getLanguage() === 'zh';
  if (isZh) {
    if (usd >= 1e8) return `≈ $${(usd / 1e8).toFixed(2)}亿`;
    if (usd >= 1e4) return `≈ $${(usd / 1e4).toFixed(usd >= 1e6 ? 1 : 2)}万`;
    if (usd >= 100) return `≈ $${Math.round(usd).toLocaleString('en-US')}`;
    return `≈ $${usd.toFixed(2)}`;
  }
  if (usd >= 1e9) return `≈ $${(usd / 1e9).toFixed(2)}B`;
  if (usd >= 1e6) return `≈ $${(usd / 1e6).toFixed(2)}M`;
  if (usd >= 1e3) return `≈ $${(usd / 1e3).toFixed(1)}K`;
  if (usd >= 100) return `≈ $${Math.round(usd).toLocaleString('en-US')}`;
  return `≈ $${usd.toFixed(2)}`;
}

function formatShortSnapshotTime(snapshotAt: string | undefined): string | null {
  if (!snapshotAt) return null;
  const date = new Date(snapshotAt);
  if (Number.isNaN(date.getTime())) return null;
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function buildQuickActionPrompt(action: TokenCardQuickAction, data: TokenCardData): string {
  const sym = `$${data.symbol}`;
  if (action === 'orders') {
    return ct(
      `Show the current sell order book for ${sym} (${data.assetKey}).`,
      `请查看 ${sym} 当前的挂单列表（按单价从低到高）。`,
    );
  }
  if (action === 'trades') {
    return ct(
      `Show the latest trade history and volume details for ${sym}.`,
      `请查看 ${sym} 的最新成交记录与近期盘口动向。`,
    );
  }
  return ct(
    `Compare available routes and prepare to buy ${sym} (${data.assetKey}).`,
    `帮我查看 ${sym}（${data.assetKey}）的最优购买渠道并准备交易。`,
  );
}

export const TokenCardStreamingPlaceholder: React.FC = () => (
  <div
    data-token-card="streaming"
    className="w-full max-w-[364px] rounded-[18px] border border-slate-900/[0.09] bg-white p-[13px] shadow-[0_4px_16px_rgba(15,23,42,0.06),0_1px_3px_rgba(15,23,42,0.04)] dark:border-white/[0.1] dark:bg-[#232529] dark:shadow-[0_10px_26px_rgba(0,0,0,0.34),0_1px_2px_rgba(0,0,0,0.24)]"
  >
    <div className="flex animate-pulse items-center justify-between gap-2.5">
      <div className="flex items-center gap-2.5">
        <div className="h-[38px] w-[38px] rounded-[11px] bg-slate-200/80 dark:bg-white/[0.08]" />
        <div className="space-y-1.5">
          <div className="h-3.5 w-20 rounded bg-slate-200/80 dark:bg-white/[0.08]" />
          <div className="h-2.5 w-24 rounded bg-slate-200/60 dark:bg-white/[0.05]" />
        </div>
      </div>
      <div className="space-y-1.5 text-right">
        <div className="ml-auto h-4 w-16 rounded bg-slate-200/80 dark:bg-white/[0.08]" />
        <div className="ml-auto h-3 w-20 rounded bg-slate-200/60 dark:bg-white/[0.05]" />
      </div>
    </div>
    <div className="mt-[11px] h-[34px] animate-pulse rounded-[10px] bg-[#f2f4f7] dark:bg-white/[0.045]" />
  </div>
);

const TokenCard: React.FC<TokenCardProps> = ({ data }) => {
  const iconSources = useMemo(
    () => resolveTokenCardIconSources(data),
    [data.icon, data.standard],
  );
  const [iconIdx, setIconIdx] = useState(0);
  const [copiedId, setCopiedId] = useState(false);

  const activeIconSrc = iconIdx < iconSources.length ? iconSources[iconIdx] : null;
  const avatarGradient = useMemo(
    () => pickAvatarGradient(data.symbol, data.chain),
    [data.symbol, data.chain],
  );
  const avatarGlyph = (data.symbol.trim().charAt(0) || 'T').toUpperCase();

  const shortAssetId = useMemo(() => formatTokenAssetShortId(data.assetKey), [data.assetKey]);
  const standardLabel = useMemo(
    () => formatTokenStandardLabel(data.chain, data.standard),
    [data.chain, data.standard],
  );
  const changeDir = data.changeDir ?? deriveChangeDir(data.change24h) ?? 'flat';
  const changeArrow = changeDir === 'up' ? '▲' : changeDir === 'down' ? '▼' : '';

  const changePillClass =
    changeDir === 'up'
      ? 'bg-[#0f9d68]/[0.11] text-[#0f9d68] dark:bg-[#34d399]/[0.13] dark:text-[#34d399]'
      : changeDir === 'down'
        ? 'bg-[#dc3545]/[0.10] text-[#dc3545] dark:bg-[#fb7185]/[0.13] dark:text-[#fb7185]'
        : 'bg-[#eaeef3] text-[#5b6472] dark:bg-white/[0.075] dark:text-[#9aa3b2]';

  const handleCopyAssetKey = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(data.assetKey).then(() => {
          setCopiedId(true);
          window.setTimeout(() => setCopiedId(false), 1500);
        });
      }
    },
    [data.assetKey],
  );

  const handleQuickAction = useCallback(
    (action: TokenCardQuickAction) => {
      if (typeof window === 'undefined') return;
      const text = buildQuickActionPrompt(action, data);
      window.dispatchEvent(
        new CustomEvent('cowork:focus-input', {
          detail: { text },
        }),
      );
    },
    [data],
  );

  const renderAvatar = () => (
    <div className="relative h-[38px] w-[38px] shrink-0">
      {activeIconSrc ? (
        <img
          src={activeIconSrc}
          alt={data.symbol}
          onError={() => setIconIdx((prev) => prev + 1)}
          className="h-[38px] w-[38px] rounded-[11px] object-cover shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]"
        />
      ) : (
        <div
          style={{ background: avatarGradient }}
          className="grid h-[38px] w-[38px] place-items-center rounded-[11px] text-[14px] font-extrabold tracking-[-0.03em] text-white shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]"
        >
          {avatarGlyph}
        </div>
      )}
      <span className=" absolute -bottom-[3px] -right-[3px] rounded-[5px] border border-slate-900/[0.09] bg-white px-[4px] py-[1px] text-[9px] font-extrabold leading-[1.2] tracking-[0.02em] text-[#1f2329] dark:border-white/[0.12] dark:bg-[#232529] dark:text-[#f4f5f8]">
        {data.chain.toUpperCase()}
      </span>
    </div>
  );

  const renderVerifyBadge = () => {
    if (data.caVerified) {
      return (
        <span
          data-token-verified="true"
          title={`${ct('Verified asset', '官方认证资产')} · ${data.assetKey}`}
          className="inline-flex shrink-0 items-center gap-[3px] whitespace-nowrap rounded-full bg-[#0f9d68]/[0.11] px-[6px] py-[1.5px] text-[10.5px] font-semibold leading-[1.3] text-[#0f9d68] dark:bg-[#34d399]/[0.13] dark:text-[#34d399]"
        >
          ✓ {ct('Verified', '认证')}
        </span>
      );
    }
    return (
      <button
        type="button"
        data-token-verified="false"
        onClick={handleCopyAssetKey}
        title={`${ct('Unverified token — click to copy full asset ID', '未认证资产，点击复制完整 ID 核对真伪')} (${data.assetKey})`}
        className="inline-flex max-w-full min-w-0 items-center overflow-hidden rounded-full border border-amber-500/35 bg-amber-500/[0.12] px-[6px] py-[1.5px] font-mono text-[10px] font-semibold leading-[1.3] text-[#b45309] transition-colors hover:bg-amber-500/[0.18] dark:border-amber-400/35 dark:bg-amber-400/[0.12] dark:text-[#fbbf24]"
      >
        <span className="min-w-0 truncate">
          ⚠ {ct('Unverified', '未认证')} · {shortAssetId.slice(0, 6)}
        </span>
      </button>
    );
  };

  const renderWalletInset = (detailedLabel: boolean) => {
    const labelText = data.botName
      ? `${data.botName} ${detailedLabel ? ct('Holding', '持仓') : ct('Balance', '余额')}`
      : detailedLabel
        ? ct('Bot Holding', 'Bot 钱包持仓')
        : ct('Bot Balance', 'Bot 钱包余额');

    return (
      <div className="mt-[10px] flex items-center justify-between gap-2 rounded-[10px] bg-[#f2f4f7] px-[10px] py-[8px] text-[12px] [font-variant-numeric:tabular-nums] dark:bg-white/[0.045]">
        <div className="flex min-w-0 items-center gap-[6px] text-[11.5px] text-[#5b6472] dark:text-[#9aa3b2]">
          <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[6px] bg-[#ffdc51] text-[10px] font-extrabold text-[#24210c]">
            B
          </span>
          <span className="truncate">{labelText}</span>
        </div>
        <div
          className={`shrink-0 text-right text-[12px] ${
            data.botZeroHolding
              ? 'font-semibold text-[#8a94a6] dark:text-[#6f7887]'
              : 'font-bold text-[#1f2329] dark:text-[#f4f5f8]'
          }`}
        >
          <span>{data.botBalanceText}</span>
          {data.botZeroHolding ? (
            <small className="ml-1 text-[11px] font-medium text-[#8a94a6] dark:text-[#6f7887]">
              {ct('None', '暂未持有')}
            </small>
          ) : data.botBalanceUsdText ? (
            <small className="ml-1 text-[11px] font-medium text-[#5b6472] dark:text-[#9aa3b2]">
              {data.botBalanceUsdText}
            </small>
          ) : null}
        </div>
      </div>
    );
  };

  const spreadTag = useMemo(() => {
    if (data.marketVsFloorPct === undefined || !Number.isFinite(data.marketVsFloorPct)) {
      return null;
    }
    const pct = data.marketVsFloorPct;
    if (Math.abs(pct) < 0.05) {
      return {
        label: ct('At floor', '与地板持平'),
        tone: 'text-[#5b6472] dark:text-[#9aa3b2]',
      };
    }
    if (pct < 0) {
      return {
        label: `${ct('Below floor', '低于地板')} ${pct.toFixed(1)}%`,
        tone: 'text-[#b45309] dark:text-[#fbbf24]',
      };
    }
    return {
      label: `${ct('Above floor', '高于地板')} +${pct.toFixed(1)}%`,
      tone: 'text-[#0f9d68] dark:text-[#34d399]',
    };
  }, [data.marketVsFloorPct]);

  const supplySub = useMemo(() => {
    if (data.standard === 'native') {
      return data.mintable === false
        ? ct('Hard-capped L1', '总量恒定上限')
        : ct('Mainnet issuance', '主网区块发行');
    }
    if (data.mintable === false) {
      return ct('Fixed · Mint locked', '固定总量 · 已锁死');
    }
    if (data.mintable === true) {
      if (data.mintProgressPct !== undefined) {
        return ct(
          `${data.mintProgressPct.toFixed(1)}% minted · Mintable`,
          `已铸 ${data.mintProgressPct.toFixed(1)}% · 可继续 Mint`,
        );
      }
      return ct('Open minting', '开放铸造中');
    }
    return ct('On-chain supply', '链上发行总量');
  }, [data.mintProgressPct, data.mintable, data.standard]);

  // =========================================================================
  // S1: Simple Mode — Clean Native Ledger (原生极简账本风)
  // =========================================================================
  if (data.mode !== 'detailed') {
    const subLeft =
      data.name && data.name.toUpperCase() !== data.symbol.toUpperCase()
        ? `${standardLabel} · ${data.name}`
        : standardLabel;
    const secondaryPrice = data.priceUsdText
      ? data.priceMain.startsWith('$')
        ? data.priceNativeText
        : `≈ ${data.priceUsdText}`
      : data.priceNativeText;

    return (
      <div
        data-token-card="simple"
        data-asset-key={data.assetKey}
        className="w-full max-w-[364px] rounded-[18px] border border-slate-900/[0.09] bg-white p-[13px] text-[#1f2329] shadow-[0_4px_16px_rgba(15,23,42,0.06),0_1px_3px_rgba(15,23,42,0.04)] dark:border-white/[0.1] dark:bg-[#232529] dark:text-[#f4f5f8] dark:shadow-[0_10px_26px_rgba(0,0,0,0.34),0_1px_2px_rgba(0,0,0,0.24)]"
      >
        <div className="flex items-center justify-between gap-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            {renderAvatar()}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-[5px]">
                <span className="text-[15px] font-bold tracking-[-0.02em]">
                  ${data.symbol}
                </span>
                {renderVerifyBadge()}
              </div>
              <div className="mt-[2px] truncate text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
                {subLeft}
              </div>
            </div>
          </div>

          <div className="shrink-0 text-right [font-variant-numeric:tabular-nums]">
            <div className="text-[16px] font-bold leading-[1.2] tracking-[-0.025em]">
              {data.priceMain}
              {data.priceUnit ? (
                <span className="ml-1 text-[12px] font-semibold text-[#5b6472] dark:text-[#9aa3b2]">
                  {data.priceUnit}
                </span>
              ) : null}
            </div>
            {(secondaryPrice || data.change24h) ? (
              <div className="mt-[3px] flex items-center justify-end gap-[5px] text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
                {secondaryPrice ? <span>{secondaryPrice}</span> : null}
                {data.change24h ? (
                  <span
                    className={`inline-flex shrink-0 items-center gap-[2px] whitespace-nowrap rounded-[7px] px-[7px] py-[2px] text-[11.5px] font-bold leading-[1.25] ${changePillClass}`}
                  >
                    {changeArrow ? `${changeArrow} ` : ''}
                    {data.change24h}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {renderWalletInset(false)}
      </div>
    );
  }

  // =========================================================================
  // D1: Detailed Mode — Modular Bento Card (模块化双列网格卡)
  // =========================================================================
  const shortTime = formatShortSnapshotTime(data.snapshotAt);
  const heroUnitLabel = data.priceUnit
    ? data.standard === 'native'
      ? data.priceUnit
      : ct(data.priceUnit, `${data.priceUnit}/枚`)
    : '';

  const marketCapSub =
    data.marketCapSubText ?? formatCompactLocaleUsd(data.marketCapUsd) ?? ct('On-chain cap', '链上流通估值');
  const volumeSub =
    data.volumeSubText ?? formatCompactLocaleUsd(data.volumeUsd) ?? ct('Cumulative', '历史累计成交');

  const holdersMain =
    data.holdersCount !== undefined
      ? `${data.holdersCount.toLocaleString('en-US')} ${ct('holders', '持有人')}`
      : data.standard === 'native'
        ? ct('Global L1', '全网公链')
        : '—';
  const communitySub =
    data.followersCount !== undefined
      ? `${data.followersCount.toLocaleString('en-US')} ${ct('followers', '关注')}`
      : data.txCount !== undefined
        ? `${data.txCount.toLocaleString('en-US')} ${ct('transfers', '笔流转')}`
        : data.standard === 'native'
          ? ct('PoW Mainnet', 'PoW 主网资产')
          : ct('On-chain addresses', '链上持币地址');

  const quickActions: TokenCardQuickAction[] =
    data.quickActions && data.quickActions.length > 0
      ? data.quickActions
      : data.standard === 'native'
        ? ['trades']
        : ['orders', 'trades', 'trade'];

  return (
    <div
      data-token-card="detailed"
      data-asset-key={data.assetKey}
      className="w-full max-w-[364px] rounded-[18px] border border-slate-900/[0.09] bg-white p-[13px] text-[#1f2329] shadow-[0_4px_16px_rgba(15,23,42,0.06),0_1px_3px_rgba(15,23,42,0.04)] dark:border-white/[0.1] dark:bg-[#232529] dark:text-[#f4f5f8] dark:shadow-[0_10px_26px_rgba(0,0,0,0.34),0_1px_2px_rgba(0,0,0,0.24)]"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {renderAvatar()}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-[5px]">
              <span className="text-[15px] font-bold tracking-[-0.02em]">
                ${data.symbol}
              </span>
              {renderVerifyBadge()}
            </div>
            <div className="mt-[2px] flex items-center gap-1 truncate text-[11px] text-[#5b6472] dark:text-[#9aa3b2]">
              <span className="truncate">{standardLabel}</span>
              <span>·</span>
              <button
                type="button"
                onClick={handleCopyAssetKey}
                title={`${ct('Copy asset ID', '复制资产 ID')}: ${data.assetKey}`}
                className="inline-flex items-center gap-0.5 font-mono text-[10.5px] text-[#5b6472] hover:text-[#1f2329] dark:text-[#9aa3b2] dark:hover:text-[#f4f5f8]"
              >
                <span>{shortAssetId}</span>
                {copiedId ? (
                  <CheckIcon className="h-3 w-3 text-[#0f9d68] dark:text-[#34d399]" />
                ) : (
                  <DocumentDuplicateIcon className="h-3 w-3 opacity-65" />
                )}
              </button>
            </div>
          </div>
        </div>

        {shortTime ? (
          <span className="shrink-0 font-mono text-[10.5px] text-[#8a94a6] [font-variant-numeric:tabular-nums] dark:text-[#6f7887]">
            {shortTime}
          </span>
        ) : null}
      </div>

      {/* Hero Price + Conversion + Floor Bar */}
      <div className="mt-[12px] border-t border-slate-900/[0.07] pt-[11px] [font-variant-numeric:tabular-nums] dark:border-white/[0.07]">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="min-w-0">
            <span className="text-[24px] font-extrabold leading-[1.1] tracking-[-0.035em]">
              {data.priceMain}
            </span>
            {heroUnitLabel ? (
              <span className="ml-[3px] text-[13px] font-semibold text-[#5b6472] dark:text-[#9aa3b2]">
                {heroUnitLabel}
              </span>
            ) : null}
          </div>

          {data.change24h ? (
            <span
              className={`inline-flex shrink-0 items-center gap-[2px] whitespace-nowrap rounded-[7px] px-[7px] py-[2.5px] text-[11.5px] font-bold leading-[1.25] ${changePillClass}`}
            >
              24h {changeArrow ? `${changeArrow} ` : ''}
              {data.change24h}
            </span>
          ) : null}
        </div>

        {(data.priceNativeText || data.priceUsdText) ? (
          <div className="mt-[4px] text-[12px] text-[#5b6472] dark:text-[#9aa3b2]">
            {data.priceNativeText ? <span>{data.priceNativeText}</span> : null}
            {data.priceNativeText && data.priceUsdText && !data.priceMain.startsWith('$') ? (
              <span> · </span>
            ) : null}
            {data.priceUsdText && !data.priceMain.startsWith('$') ? (
              <span>
                {ct('Est. ', '折算约 ')}
                <strong className="font-semibold text-[#1f2329] dark:text-[#f4f5f8]">
                  {data.priceUsdText}
                </strong>
              </span>
            ) : null}
          </div>
        ) : null}

        {data.floorPriceText ? (
          <div className="mt-[10px] flex items-center justify-between gap-2 rounded-[9px] border border-slate-900/[0.07] bg-[#f2f4f7] px-[10px] py-[7px] text-[11.5px] dark:border-white/[0.07] dark:bg-white/[0.045]">
            <span className="min-w-0 truncate text-[#5b6472] dark:text-[#9aa3b2]">
              {ct('Floor ', '地板价 ')}
              <strong className="font-bold text-[#1f2329] dark:text-[#f4f5f8]">
                {data.floorPriceText}
              </strong>
              {data.floorUsdText ? (
                <span className="ml-1 text-[11px] opacity-85">({data.floorUsdText})</span>
              ) : null}
            </span>
            {spreadTag ? (
              <span className={`shrink-0 text-[11px] font-semibold ${spreadTag.tone}`}>
                {spreadTag.label}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 2x2 Modular Bento Grid */}
      <div className="mt-[10px] grid grid-cols-2 gap-[7px] [font-variant-numeric:tabular-nums]">
        <div className="min-w-0 rounded-[10px] bg-[#f2f4f7] px-[10px] py-[8px] dark:bg-white/[0.045]">
          <div className="text-[10.5px] font-medium text-[#8a94a6] dark:text-[#6f7887]">
            {ct('Market Cap', '总市值')}
          </div>
          <div className="mt-[3px] truncate text-[13px] font-bold tracking-[-0.015em]">
            {data.marketCapMain || '—'}
          </div>
          <div className="mt-[1px] truncate text-[10.5px] text-[#5b6472] dark:text-[#9aa3b2]">
            {marketCapSub}
          </div>
        </div>

        <div className="min-w-0 rounded-[10px] bg-[#f2f4f7] px-[10px] py-[8px] dark:bg-white/[0.045]">
          <div className="text-[10.5px] font-medium text-[#8a94a6] dark:text-[#6f7887]">
            {ct('Total Volume', '累计成交')}
          </div>
          <div className="mt-[3px] truncate text-[13px] font-bold tracking-[-0.015em]">
            {data.volumeMain || '—'}
          </div>
          <div className="mt-[1px] truncate text-[10.5px] text-[#5b6472] dark:text-[#9aa3b2]">
            {volumeSub}
          </div>
        </div>

        <div className="min-w-0 rounded-[10px] bg-[#f2f4f7] px-[10px] py-[8px] dark:bg-white/[0.045]">
          <div className="text-[10.5px] font-medium text-[#8a94a6] dark:text-[#6f7887]">
            {ct('Community', '社区持仓')}
          </div>
          <div className="mt-[3px] truncate text-[13px] font-bold tracking-[-0.015em]">
            {holdersMain}
          </div>
          <div className="mt-[1px] truncate text-[10.5px] text-[#5b6472] dark:text-[#9aa3b2]">
            {communitySub}
          </div>
        </div>

        <div className="min-w-0 rounded-[10px] bg-[#f2f4f7] px-[10px] py-[8px] dark:bg-white/[0.045]">
          <div className="text-[10.5px] font-medium text-[#8a94a6] dark:text-[#6f7887]">
            {ct('Total Supply', '发行总量')}
          </div>
          <div className="mt-[3px] truncate text-[13px] font-bold tracking-[-0.015em]">
            {data.supplyMain || '—'}
          </div>
          <div className="mt-[1px] truncate text-[10.5px] text-[#5b6472] dark:text-[#9aa3b2]">
            {supplySub}
          </div>
        </div>
      </div>

      {/* Bot Wallet Holding Inset */}
      {renderWalletInset(true)}

      {/* Quick Follow-Up Action Chips */}
      {quickActions.length > 0 ? (
        <div className="mt-[10px] flex flex-wrap items-center justify-end gap-[6px]">
          {quickActions.map((action) => {
            const isPrimary = action === 'trade';
            const label =
              action === 'orders'
                ? ct('Sell Orders', '挂单列表')
                : action === 'trades'
                  ? ct('Recent Trades', '最新成交')
                  : ct('Trade', '去交易');

            return (
              <button
                key={action}
                type="button"
                data-token-action={action}
                onClick={() => handleQuickAction(action)}
                className={
                  isPrimary
                    ? 'inline-flex min-h-[30px] items-center gap-1 rounded-[8px] border border-black/[0.08] bg-[#ffdc51] px-[10px] py-[5px] text-[11px] font-bold text-[#24210c] transition-transform active:scale-[0.96] hover:brightness-[0.98]'
                    : 'inline-flex min-h-[30px] items-center gap-1 rounded-[8px] border border-slate-900/[0.09] bg-[#f2f4f7] px-[10px] py-[5px] text-[11px] font-semibold text-[#5b6472] transition-colors active:scale-[0.96] hover:border-[#b48a00]/30 hover:bg-[#ffdc51]/20 hover:text-[#1f2329] dark:border-white/[0.1] dark:bg-white/[0.045] dark:text-[#9aa3b2] dark:hover:border-[#ffdc51]/30 dark:hover:bg-[#ffdc51]/[0.11] dark:hover:text-[#f4f5f8]'
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};

export default TokenCard;
