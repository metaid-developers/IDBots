import React, { useEffect, useState } from 'react';
import { ct } from '../commerce/commerceTradeI18n';
import type { AssetBridgeChain, AssetBridgeJobView, AssetBridgeNoticeFenceData } from './assetBridgeCardSyntax';

function chainLabel(chain: AssetBridgeChain): string {
  return chain === 'btc' ? 'BTC' : 'MVC';
}

function sourceChainForScenario(scenario: AssetBridgeNoticeFenceData['scenario']): AssetBridgeChain {
  return scenario === 'btc_mint' || scenario === 'mrc20_mint' ? 'btc' : 'mvc';
}

function shortHash(value: string | undefined): string {
  if (!value) return '—';
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes <= 0) return ct(`${secs} sec`, `${secs} 秒`);
  return ct(`${minutes}m ${String(secs).padStart(2, '0')}s`, `${minutes} 分 ${String(secs).padStart(2, '0')} 秒`);
}

const MiniDisc: React.FC<{ chain: AssetBridgeChain }> = ({ chain }) => (
  <span
    className={`grid h-[25px] w-[25px] place-items-center rounded-full border-2 border-white text-[9px] font-extrabold text-white dark:border-[#232529] ${
      chain === 'btc' ? 'bg-[#f7931a]' : 'bg-[#0284c7]'
    }`}
  >
    {chain === 'btc' ? 'B' : 'M'}
  </span>
);

export interface AssetBridgeNoticeCardProps {
  data: AssetBridgeNoticeFenceData;
}

/**
 * Compact host-authored bridge completion/failure pill. The fence carries the
 * display snapshot; the optional desktop lookup only supplies the origin
 * session id for the “View original card” navigation link.
 */
const AssetBridgeNoticeCard: React.FC<AssetBridgeNoticeCardProps> = ({ data }) => {
  const [job, setJob] = useState<AssetBridgeJobView | null>(null);
  const sourceChain = sourceChainForScenario(data.scenario);
  const completed = data.status === 'completed';

  useEffect(() => {
    let cancelled = false;
    const api = typeof window !== 'undefined' ? window.electron?.assetBridge : null;
    if (!api) return undefined;
    void api.get({ jobId: data.jobId }).then((result) => {
      if (!cancelled) setJob(result);
    }).catch(() => {
      if (!cancelled) setJob(null);
    });
    return () => {
      cancelled = true;
    };
  }, [data.jobId]);

  const openOriginal = () => {
    if (!job?.sessionId || typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('cowork:viewSession', { detail: { sessionId: job.sessionId } }));
  };

  const reason = data.reasonEn || data.reasonZh
    ? ct(data.reasonEn || data.reasonZh || '', data.reasonZh || data.reasonEn || '')
    : '';

  return (
    <div
      data-asset-bridge-notice="true"
      data-status={data.status}
      className="w-full max-w-[330px] rounded-[15px] border border-slate-900/[0.09] bg-white px-[10px] py-[9px] text-[#1f2329] shadow-[0_4px_16px_rgba(15,23,42,0.06),0_1px_3px_rgba(15,23,42,0.04)] dark:border-white/[0.1] dark:bg-[#232529] dark:text-[#f4f5f8] dark:shadow-[0_10px_26px_rgba(0,0,0,0.34),0_1px_2px_rgba(0,0,0,0.24)]"
    >
      <div className="flex min-w-0 items-center gap-[8px]">
        <div className="flex shrink-0 items-center">
          <MiniDisc chain={sourceChain} />
          <span className="-ml-[6px]"><MiniDisc chain={data.targetChain} /></span>
        </div>
        <div className="min-w-0 flex-1">
          {completed ? (
            <>
              <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-bold [font-variant-numeric:tabular-nums]">
                +{data.amountDisplay} {data.targetSymbol} {ct('on', '到')} {chainLabel(data.targetChain)} · {formatDuration(data.durationSec)}
              </div>
              <div className="mt-[2px] overflow-hidden text-ellipsis whitespace-nowrap text-[10.5px] text-[#5b6472] [font-variant-numeric:tabular-nums] dark:text-[#9aa3b2]">
                {ct('target tx', '目标交易')} {shortHash(data.targetTxid)}
              </div>
            </>
          ) : (
            <>
              <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-bold text-[#b45309] dark:text-[#fbbf24]">
                {ct('Bridge failed', '桥接失败')} · {data.amountDisplay} {data.targetSymbol}
              </div>
              <div className="mt-[2px] overflow-hidden text-ellipsis whitespace-nowrap text-[10.5px] text-[#b45309] dark:text-[#fbbf24]">
                {reason || ct('See the original bridge card for details.', '请查看原桥接卡了解详情。')}
              </div>
            </>
          )}
        </div>
        {job?.sessionId && (
          <>
            <button
              type="button"
              onClick={openOriginal}
              className="shrink-0 text-[11px] font-bold text-[#0369a1] transition hover:opacity-80 dark:text-[#38bdf8]"
            >
              {ct('View original card', '查看原卡')}
            </button>
            <span className="pl-[3px] text-[16px] text-[#8a94a6] dark:text-[#6f7887]">›</span>
          </>
        )}
      </div>
    </div>
  );
};

export default AssetBridgeNoticeCard;
