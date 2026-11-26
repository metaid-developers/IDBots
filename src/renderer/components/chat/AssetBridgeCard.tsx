import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ct } from '../commerce/commerceTradeI18n';
import type {
  AssetBridgeCardFenceData,
  AssetBridgeChain,
  AssetBridgeFeeBreakdown,
  AssetBridgeJobView,
} from './assetBridgeCardSyntax';
import { computeAssetBridgeProgress } from './assetBridgeProgress';
import {
  ChainStandardBadge,
  CopyShortHashButton,
  dispatchSuiteComposerDraft,
  TK_BTN_PRIMARY,
  TK_CARD_SHELL,
  TK_CHIP_BTN,
  TK_INSET_BOX,
} from './tokenSuiteUi';

export type AssetBridgeCardMode = 'live' | 'snapshot-missing-api' | 'snapshot-not-found';
type BridgeAction = 'confirm' | 'cancel' | 'refresh';

export interface AssetBridgeJobHookResult {
  job: AssetBridgeJobView | null;
  loading: boolean;
  now: number;
  reload: () => Promise<AssetBridgeJobView | null>;
  setJob: React.Dispatch<React.SetStateAction<AssetBridgeJobView | null>>;
}

function assetBridgeApi(): Window['electron']['assetBridge'] | null {
  if (typeof window === 'undefined') return null;
  return window.electron?.assetBridge ?? null;
}

export function useAssetBridgeJob(jobId: string): AssetBridgeJobHookResult {
  const [job, setJob] = useState<AssetBridgeJobView | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(async () => {
    const api = assetBridgeApi();
    if (!api) {
      setJob(null);
      setLoading(false);
      return null;
    }
    try {
      const next = await api.get({ jobId });
      setJob(next);
      return next;
    } catch {
      setJob(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    setLoading(true);
    setJob(null);
    void reload();
  }, [reload]);

  useEffect(() => {
    const api = assetBridgeApi();
    if (!api) return undefined;
    return api.onJobUpdated((payload) => {
      if (payload?.jobId === jobId) setJob(payload);
    });
  }, [jobId]);

  useEffect(() => {
    if (job?.state !== 'quote' && job?.state !== 'bridging') return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [job?.state]);

  return { job, loading, now, reload, setJob };
}

function chainLabel(chain: AssetBridgeChain): string {
  return chain === 'btc' ? 'BTC' : 'MVC';
}

function shortAddress(value: string): string {
  if (!value) return '—';
  if (value.length <= 14) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return ct(`${minutes} min ${seconds} s`, `${minutes} 分 ${seconds} 秒`);
}

function formatLongDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes <= 0) return ct(`${seconds} sec`, `${seconds} 秒`);
  return ct(`${minutes} min ${String(seconds).padStart(2, '0')} sec`, `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`);
}

function trimDecimal(value: number): string {
  return value.toFixed(8).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function etaText(blocks: number, minutes: number): string {
  return ct(
    `${blocks} ${blocks === 1 ? 'block' : 'blocks'} · about ${minutes} min`,
    `${blocks} 个区块 · 约 ${minutes} 分钟`,
  );
}

function btcFeeText(sats: number): string {
  return `${Math.round(sats).toLocaleString('en-US')} sats BTC`;
}

function mvcFeeText(sats: number): string {
  return `${trimDecimal(sats / 1e8)} SPACE`;
}

function joinFeeText(btcSats: number, mvcSats: number): string {
  const parts: string[] = [];
  if (mvcSats > 0) parts.push(mvcFeeText(mvcSats));
  if (btcSats > 0) parts.push(btcFeeText(btcSats));
  return parts.length > 0 ? parts.join(' + ') : '—';
}

function walletMinerText(fees: AssetBridgeFeeBreakdown): string {
  const parts: string[] = [];
  if (fees.walletMinerMvcSats > 0) {
    parts.push(`${fees.walletMinerMvcEstimated ? '≈' : ''}${mvcFeeText(fees.walletMinerMvcSats)}`);
  }
  if (fees.walletMinerBtcSats > 0) parts.push(btcFeeText(fees.walletMinerBtcSats));
  return parts.length > 0 ? parts.join(' + ') : '—';
}

function arcPoint(t: number): { x: number; y: number } {
  const p0 = { x: 45, y: 64 };
  const p1 = { x: 104, y: 4 };
  const p2 = { x: 216, y: 4 };
  const p3 = { x: 275, y: 64 };
  const u = 1 - t;
  return {
    x: (u ** 3 * p0.x) + (3 * u ** 2 * t * p1.x) + (3 * u * t ** 2 * p2.x) + (t ** 3 * p3.x),
    y: (u ** 3 * p0.y) + (3 * u ** 2 * t * p1.y) + (3 * u * t ** 2 * p2.y) + (t ** 3 * p3.y),
  };
}

const ChainDisc: React.FC<{
  chain: AssetBridgeChain;
  side: 'source' | 'target';
  complete?: boolean;
}> = ({ chain, side, complete = false }) => (
  <div
    className={`absolute top-[34px] z-[2] grid h-[54px] w-[54px] place-items-center rounded-full text-[13px] font-extrabold tracking-[-0.02em] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22),0_8px_18px_rgba(0,0,0,0.18)] ${
      side === 'source' ? 'left-[4px]' : 'right-[4px]'
    } ${chain === 'btc' ? 'bg-[linear-gradient(145deg,#f7931a,#c26200)]' : 'bg-[linear-gradient(145deg,#0ea5e9,#0369a1)]'}`}
  >
    {complete && (
      <span className="absolute -right-[3px] -top-[3px] grid h-[20px] w-[20px] place-items-center rounded-full border-2 border-white bg-[#0f9d68] text-[12px] text-white dark:border-[#232529] dark:bg-[#34d399] dark:text-[#0f172a]">
        ✓
      </span>
    )}
    {chainLabel(chain)}
    <span className="absolute -bottom-[6px] rounded-full border border-slate-900/[0.09] bg-white px-[5px] py-[1px] text-[9px] font-bold text-[#5b6472] dark:border-white/[0.1] dark:bg-[#232529] dark:text-[#9aa3b2]">
      {chainLabel(chain)}
    </span>
  </div>
);

const BridgeArcHero: React.FC<{
  job: AssetBridgeJobView;
  mode: 'quote' | 'bridging' | 'completed';
  now: number;
}> = ({ job, mode, now }) => {
  const required = Math.max(1, Math.floor(job.requiredConfirmations ?? job.eta.blocks ?? 1));
  const progress = computeAssetBridgeProgress({
    state: mode === 'completed' ? 'completed' : job.state,
    stage: job.stage,
    requiredConfirmations: required,
    confirmations: job.confirmations,
    lastConfirmationAt: job.lastConfirmationAt,
    broadcastAt: job.broadcastAt,
    now,
  });
  const fraction = mode === 'quote' ? 0 : progress.percent / 100;
  const dot = arcPoint(Math.max(0, Math.min(1, fraction)));
  const ticks = Array.from({ length: required }, (_, index) => {
    const blockNumber = index + 1;
    const point = arcPoint(blockNumber / (required + 0.5));
    const done = mode === 'completed' || (mode !== 'quote' && progress.blocksDone >= blockNumber);
    return { blockNumber, point, done };
  });

  return (
    <div className="relative min-h-[116px] px-[2px] pt-[4px]">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress.percent)}
        aria-label={ct('Bridge progress', '桥接进度')}
      >
        <svg className="absolute left-[28px] right-[28px] top-0 h-[104px] w-[calc(100%-56px)] overflow-visible" viewBox="0 0 320 104">
          <path
            className={mode === 'quote'
              ? 'fill-none stroke-[#8a94a6] stroke-[2] opacity-65 [stroke-dasharray:4_7] [stroke-linecap:round] dark:stroke-[#6f7887]'
              : 'fill-none stroke-[#e8ecf2] stroke-[5] [stroke-linecap:round] dark:stroke-white/[0.08]'}
            d="M45 64 C104 4 216 4 275 64"
          />
          {mode !== 'quote' && (
            <path
              className="fill-none stroke-[#ffdc51] stroke-[5] [stroke-linecap:round]"
              pathLength={1}
              strokeDasharray={`${Math.max(0.006, fraction)} 1`}
              d="M45 64 C104 4 216 4 275 64"
            />
          )}
          {ticks.map(({ blockNumber, point, done }) => (
            <g key={blockNumber}>
              <circle
                cx={point.x.toFixed(1)}
                cy={point.y.toFixed(1)}
                r="5.2"
                className={done
                  ? 'fill-[#0f9d68] stroke-[#0f9d68] dark:fill-[#34d399] dark:stroke-[#34d399]'
                  : 'fill-white stroke-[#8a94a6] stroke-[1.5] dark:fill-[#232529] dark:stroke-[#6f7887]'}
              />
              <text
                x={point.x.toFixed(1)}
                y={(point.y + 2.6).toFixed(1)}
                textAnchor="middle"
                fontSize="6.5"
                fontWeight="800"
                className={done ? 'fill-white dark:fill-[#0f172a]' : 'fill-[#8a94a6] dark:fill-[#6f7887]'}
              >
                {blockNumber}
              </text>
            </g>
          ))}
          {mode !== 'quote' && (
            <circle
              cx={dot.x.toFixed(1)}
              cy={dot.y.toFixed(1)}
              r="8"
              className="fill-[#ffdc51] stroke-white stroke-[3] transition-all duration-300 motion-reduce:transition-none dark:stroke-[#232529] [filter:drop-shadow(0_0_8px_rgba(255,220,81,0.75))]"
            />
          )}
        </svg>
      </div>
      <ChainDisc chain={job.sourceChain} side="source" />
      <ChainDisc chain={job.targetChain} side="target" complete={mode === 'completed'} />
    </div>
  );
};

const LedgerRow: React.FC<{
  label: string;
  value: React.ReactNode;
  positive?: boolean;
}> = ({ label, value, positive = false }) => (
  <div className="flex min-w-0 items-baseline justify-between gap-2 text-[12px]">
    <span className="shrink-0 text-[#5b6472] dark:text-[#9aa3b2]">{label}</span>
    <span className={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-right font-semibold ${positive ? 'text-[#0f9d68] dark:text-[#34d399]' : 'text-[#1f2329] dark:text-[#f4f5f8]'}`}>
      {value}
    </span>
  </div>
);

const WarnBox: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rounded-[11px] border border-amber-500/30 bg-amber-500/[0.12] px-[10px] py-[8px] text-[12px] leading-[1.48] text-[#b45309] dark:border-amber-400/30 dark:bg-amber-400/[0.12] dark:text-[#fbbf24]">
    {children}
  </div>
);

const DownBox: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rounded-[11px] border border-[#dc3545]/25 bg-[#dc3545]/[0.1] px-[10px] py-[8px] text-[12px] leading-[1.48] text-[#dc3545] dark:border-[#fb7185]/30 dark:bg-[#fb7185]/[0.13] dark:text-[#fb7185]">
    {children}
  </div>
);

const AmountLine: React.FC<{ job: AssetBridgeJobView }> = ({ job }) => (
  <div className="mt-[-3px] whitespace-nowrap text-center text-[15px] min-[380px]:text-[18px] font-extrabold leading-[1.2] tracking-[-0.025em] [font-variant-numeric:tabular-nums]">
    {job.amountDisplay} {job.symbol}
    <span className="px-[4px] font-semibold text-[#5b6472] dark:text-[#9aa3b2]">→</span>
    {job.receiveAmountDisplay} {job.targetSymbol}
  </div>
);

const RouteBadges: React.FC<{ job: AssetBridgeJobView }> = ({ job }) => (
  <div className="flex flex-wrap justify-center gap-[6px]">
    <ChainStandardBadge chain={job.sourceChain} standard={job.sourceStandard} />
    <ChainStandardBadge chain={job.targetChain} standard={job.targetStandard} />
  </div>
);

const QuoteSummaryRows: React.FC<{ job: AssetBridgeJobView; fees: AssetBridgeFeeBreakdown }> = ({ job, fees }) => (
  <div className={`${TK_INSET_BOX} flex flex-col gap-[6px] [font-variant-numeric:tabular-nums]`}>
    <LedgerRow label={ct('You receive', '你将收到')} value={`${job.receiveAmountDisplay} ${job.targetSymbol}`} positive />
    <LedgerRow label={ct('Total fee', '总费用')} value={joinFeeText(fees.totalBtcSats, fees.totalMvcSats)} />
    <LedgerRow
      label={ct('ETA', '预计到账')}
      value={etaText(job.eta.blocks, job.eta.minutes)}
    />
  </div>
);

const FeeDetails: React.FC<{ job: AssetBridgeJobView; fees: AssetBridgeFeeBreakdown }> = ({ job, fees }) => {
  const redeem = job.scenario === 'btc_redeem' || job.scenario === 'mrc20_redeem';
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center justify-between text-[12px] font-semibold text-[#5b6472] dark:text-[#9aa3b2]">
        <span>{ct('Fee details', '费用明细')}</span>
        <span className="flex items-center gap-[6px] [font-variant-numeric:tabular-nums]">
          <span>{joinFeeText(fees.totalBtcSats, fees.totalMvcSats)}</span>
          <span className="text-[10px] font-normal text-[#8a94a6] group-open:hidden dark:text-[#6f7887]">{ct('Expand', '展开')}</span>
          <span className="hidden text-[10px] font-normal text-[#8a94a6] group-open:inline dark:text-[#6f7887]">{ct('Collapse', '收起')}</span>
        </span>
      </summary>
      <div className={`${TK_INSET_BOX} mt-[7px] flex flex-col gap-[6px] [font-variant-numeric:tabular-nums]`}>
        <LedgerRow label={ct('Service fee', '桥服务费')} value={joinFeeText(fees.serviceBtcSats, fees.serviceMvcSats)} />
        {redeem && (
          <LedgerRow label={ct('Bridge payout miner fee', '桥支付矿工费')} value={joinFeeText(fees.bridgeMinerBtcSats, fees.bridgeMinerMvcSats)} />
        )}
        <LedgerRow
          label={ct('Network miner fee for your wallet', '你的钱包网络矿工费')}
          value={walletMinerText(fees)}
        />
        {job.poolCapDisplay && (
          <LedgerRow label={ct('Single-transfer liquidity cap', '单笔流动性上限')} value={`${job.poolCapDisplay} ${job.symbol}`} />
        )}
        <div className="h-[1px] bg-slate-900/[0.07] dark:bg-white/[0.07]" />
        <LedgerRow label={ct('Total', '合计')} value={joinFeeText(fees.totalBtcSats, fees.totalMvcSats)} />
      </div>
    </details>
  );
};

const WalletLine: React.FC<{ job: AssetBridgeJobView }> = ({ job }) => (
  <div className="text-[12px] leading-[1.45] text-[#5b6472] [font-variant-numeric:tabular-nums] dark:text-[#9aa3b2]">
    {ct('Sending and receiving wallet', '付款与接收钱包')}: {job.metabotName} · BTC {shortAddress(job.btcAddress)} · MVC {shortAddress(job.mvcAddress)}
  </div>
);

const SnapshotNote: React.FC<{ mode: AssetBridgeCardMode }> = ({ mode }) => {
  if (mode === 'snapshot-missing-api') {
    return (
      <WarnBox>
        {ct('Confirm and track this bridge in IDBots desktop', '请在桌面端 IDBots 中确认与查看')}
      </WarnBox>
    );
  }
  if (mode === 'snapshot-not-found') {
    return (
      <WarnBox>
        {ct('This bridge record is not on this device', '该桥接记录不在本机')}
      </WarnBox>
    );
  }
  return null;
};

function snapshotJobFromCard(snapshot: AssetBridgeCardFenceData): AssetBridgeJobView {
  const btcSource = snapshot.scenario === 'btc_mint' || snapshot.scenario === 'mrc20_mint';
  const mrc20 = snapshot.scenario === 'mrc20_mint' || snapshot.scenario === 'mrc20_redeem';
  const zeroFees: AssetBridgeFeeBreakdown = {
    serviceBtcSats: 0,
    serviceMvcSats: 0,
    bridgeMinerBtcSats: 0,
    bridgeMinerMvcSats: 0,
    walletMinerBtcSats: 0,
    walletMinerMvcSats: 0,
    totalBtcSats: 0,
    totalMvcSats: 0,
    btcFeeRate: 0,
    walletMinerMvcEstimated: true,
  };
  return {
    jobId: snapshot.jobId,
    metabotId: 0,
    metabotName: '—',
    sessionId: '',
    scenario: snapshot.scenario,
    sourceChain: btcSource ? 'btc' : 'mvc',
    targetChain: btcSource ? 'mvc' : 'btc',
    sourceStandard: btcSource ? (mrc20 ? 'mrc20' : 'native') : (snapshot.scenario === 'btc_redeem' || mrc20 ? 'mvc-ft' : 'native'),
    targetStandard: btcSource ? (snapshot.scenario === 'btc_mint' ? 'mvc-ft' : 'mvc-ft') : (mrc20 ? 'mrc20' : 'native'),
    symbol: snapshot.symbol,
    targetSymbol: snapshot.targetSymbol,
    amountDisplay: snapshot.amountDisplay,
    receiveAmountDisplay: snapshot.amountDisplay,
    fromAddress: '',
    receiveAddress: '',
    btcAddress: '',
    mvcAddress: '',
    fees: zeroFees,
    balances: { sourceAssetDisplay: '', btcSats: 0, mvcSats: 0 },
    blockers: [],
    poolCapDisplay: null,
    eta: { blocks: snapshot.scenario === 'mrc20_mint' ? 3 : 1, blockChain: btcSource ? 'btc' : 'mvc', minutes: snapshot.scenario === 'mrc20_mint' ? 31 : 11 },
    quoteExpiresAt: 0,
    state: snapshot.state,
    stage: null,
    orderId: null,
    sourceTxid: null,
    targetTxid: null,
    requiredConfirmations: snapshot.scenario === 'mrc20_mint' ? 3 : 1,
    confirmations: 0,
    lastConfirmationAt: null,
    broadcastAt: null,
    completedAt: null,
    feesPaid: null,
    error: null,
    notice: null,
    onComplete: null,
    updatedAt: 0,
  };
}

export interface AssetBridgeCardViewProps {
  job: AssetBridgeJobView;
  snapshot: AssetBridgeCardFenceData;
  now: number;
  mode: AssetBridgeCardMode;
  onConfirm: () => void;
  onCancel: () => void;
  onRefresh: () => void;
  busyAction?: BridgeAction | null;
  actionError?: string | null;
}

export const AssetBridgeCardView: React.FC<AssetBridgeCardViewProps> = ({
  job,
  snapshot,
  now,
  mode,
  onConfirm,
  onCancel,
  onRefresh,
  busyAction = null,
  actionError = null,
}) => {
  void snapshot;
  const readOnly = mode !== 'live';
  const effectiveState: AssetBridgeJobView['state'] = job.state === 'quote' && job.quoteExpiresAt > 0 && now >= job.quoteExpiresAt
    ? 'expired'
    : job.state;
  const fees = job.feesPaid ?? job.fees;
  const blocked = job.blockers.length > 0;
  const progress = computeAssetBridgeProgress({
    state: effectiveState,
    stage: job.stage,
    requiredConfirmations: job.requiredConfirmations ?? job.eta.blocks,
    confirmations: job.confirmations,
    lastConfirmationAt: job.lastConfirmationAt,
    broadcastAt: job.broadcastAt,
    now,
  });
  const elapsedMs = job.broadcastAt ? Math.max(0, now - job.broadcastAt) : 0;
  const completedDurationMs = job.broadcastAt && job.completedAt ? Math.max(0, job.completedAt - job.broadcastAt) : elapsedMs;
  const chainUpper = chainLabel(job.eta.blockChain);

  const actionErrorBox = actionError ? <DownBox>{actionError}</DownBox> : null;

  let body: React.ReactNode;
  if (effectiveState === 'cancelled') {
    body = (
      <div className="rounded-[11px] bg-[#f2f4f7] px-[10px] py-[8px] text-[12px] text-[#5b6472] dark:bg-white/[0.045] dark:text-[#9aa3b2]">
        {ct('Bridge quote cancelled. No funds were moved.', '桥接报价已取消，资金未转出。')}
      </div>
    );
  } else if (effectiveState === 'quote' || effectiveState === 'signing') {
    const signing = effectiveState === 'signing';
    body = (
      <>
        <div className={signing ? 'flex flex-col gap-[10px] opacity-75' : 'flex flex-col gap-[10px]'}>
          <BridgeArcHero job={job} mode="quote" now={now} />
          <AmountLine job={job} />
          <RouteBadges job={job} />
          <QuoteSummaryRows job={job} fees={fees} />
          {!signing && <FeeDetails job={job} fees={fees} />}
        </div>
        <WalletLine job={job} />
        <SnapshotNote mode={mode} />
        {job.error && (
          <WarnBox>{ct(job.error.messageEn, job.error.messageZh)}</WarnBox>
        )}
        {blocked && (
          <WarnBox>
            <div className="flex flex-col gap-[5px]">
              {job.blockers.map((blocker) => (
                <div key={`${blocker.code}-${blocker.messageEn}`}>{ct(blocker.messageEn, blocker.messageZh)}</div>
              ))}
            </div>
          </WarnBox>
        )}
        {signing ? (
          <div className="flex min-h-[68px] flex-col justify-center gap-[7px]">
            <div className="flex items-center gap-[8px] rounded-[11px] border border-[#b48a00]/30 bg-[#ffdc51]/[0.22] px-[9px] py-[7px] text-[11.5px] font-bold text-[#7a5b00] dark:border-[#ffdc51]/30 dark:bg-[#ffdc51]/[0.12] dark:text-[#ffdc51]">
              <span className="h-[14px] w-[14px] shrink-0 animate-spin rounded-full border-2 border-[#b48a00]/30 border-t-[#7a5b00] dark:border-[#ffdc51]/30 dark:border-t-[#ffdc51] motion-reduce:animate-none" />
              <span>{ct('Signing and broadcasting…', '正在签名并广播源链交易…')}</span>
            </div>
          </div>
        ) : !readOnly ? (
          <>
            {actionErrorBox}
            <button
              type="button"
              aria-label={ct('Confirm bridge', '确认桥接')}
              disabled={blocked || busyAction !== null}
              onClick={onConfirm}
              className={`${TK_BTN_PRIMARY} disabled:border disabled:border-slate-900/[0.09] disabled:bg-[#f2f4f7] disabled:text-[#8a94a6] disabled:opacity-100 disabled:shadow-none dark:disabled:border-white/[0.1] dark:disabled:bg-white/[0.045] dark:disabled:text-[#6f7887]`}
            >
              {busyAction === 'confirm' ? ct('Confirming…', '确认中…') : ct('Confirm bridge', '确认桥接')}
            </button>
            <div className="text-center text-[12px] text-[#8a94a6] [font-variant-numeric:tabular-nums] dark:text-[#6f7887]">
              {ct(`Quote expires in ${formatCountdown(job.quoteExpiresAt - now)}`, `报价 ${formatCountdown(job.quoteExpiresAt - now)} 后失效`)}
            </div>
            <button
              type="button"
              aria-label={ct('Cancel bridge quote', '取消桥接报价')}
              disabled={busyAction !== null}
              onClick={onCancel}
              className="px-[4px] py-[6px] text-[11.5px] font-semibold text-[#5b6472] transition hover:text-[#1f2329] disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#9aa3b2] dark:hover:text-[#f4f5f8]"
            >
              {busyAction === 'cancel' ? ct('Cancelling…', '取消中…') : blocked ? ct('Top up first / Cancel', '先补足费用 / 取消') : ct('Cancel', '取消')}
            </button>
          </>
        ) : null}
      </>
    );
  } else if (effectiveState === 'bridging') {
    const remainingText = progress.pinned
      ? ct('waiting for the block', '等待这个区块')
      : progress.remainingMinutes != null
        ? ct(`about ${progress.remainingMinutes} min`, `约 ${progress.remainingMinutes} 分钟`)
        : '—';
    const stageText = progress.payoutActive
      ? ct('Bridge is paying out', '桥节点正在目标链入账')
      : ct(`Waiting for ${chainUpper} block ${progress.currentBlockIndex} of ${job.requiredConfirmations ?? job.eta.blocks}`, `等待 ${chainUpper} 区块 ${progress.currentBlockIndex} / ${job.requiredConfirmations ?? job.eta.blocks}`);
    body = (
      <>
        <BridgeArcHero job={job} mode="bridging" now={now} />
        <div className="pt-[1px] text-center">
          <div className="text-[34px] font-extrabold leading-none tracking-[-0.045em] [font-variant-numeric:tabular-nums]">
            {Math.floor(progress.percent)}<span className="text-[18px]">%</span>
          </div>
          <div className="mt-[4px] text-[12px] font-semibold text-[#5b6472] [font-variant-numeric:tabular-nums] dark:text-[#9aa3b2]">{remainingText}</div>
          <div className="mt-[2px] text-[10px] min-[380px]:text-[11.5px] text-[#8a94a6] [font-variant-numeric:tabular-nums] dark:text-[#6f7887]">
            {stageText}
          </div>
        </div>
        {progress.pinned && (
          <WarnBox>
            {ct(`${chainUpper} blocks are slower than average right now. This is normal; the bridge continues as soon as the block is found.`, `${chainUpper} 当前出块慢于平均值，这是正常现象；出块后桥接会自动继续。`)}
          </WarnBox>
        )}
        <div className="text-[12px] leading-[1.45] text-[#5b6472] dark:text-[#9aa3b2]">
          {ct('You can leave — I will tell you in chat when it arrives.', '你可以离开——到账后我会在聊天里告诉你。')}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center rounded-[6px] border border-slate-900/[0.09] bg-[#f2f4f7] px-[6.5px] py-[2px] text-[10.5px] font-semibold text-[#5b6472] [font-variant-numeric:tabular-nums] dark:border-white/[0.1] dark:bg-white/[0.045] dark:text-[#9aa3b2]">
            {ct('elapsed', '已用')} {formatElapsed(elapsedMs)}
          </span>
          {job.sourceTxid ? (
            <span className="inline-flex max-w-[58%] items-center rounded-full border border-slate-900/[0.09] bg-[#f2f4f7] px-[7px] py-[3px] dark:border-white/[0.1] dark:bg-white/[0.045]">
              <CopyShortHashButton value={job.sourceTxid} />
            </span>
          ) : <span />}
        </div>
      </>
    );
  } else if (effectiveState === 'completed') {
    body = (
      <>
        <BridgeArcHero job={job} mode="completed" now={now} />
        <div className="pt-[1px] text-center">
          <div className="text-[25px] font-extrabold leading-none tracking-[-0.035em] text-[#0f9d68] [font-variant-numeric:tabular-nums] dark:text-[#34d399]">
            +{job.receiveAmountDisplay} {job.targetSymbol}
          </div>
          <div className="mt-[4px] text-[12px] font-semibold text-[#5b6472] dark:text-[#9aa3b2]">{ct('arrived', '已到账')}</div>
        </div>
        <div className={`${TK_INSET_BOX} flex flex-col gap-[6px] [font-variant-numeric:tabular-nums]`}>
          {job.sourceTxid && <LedgerRow label={ct('Source transaction', '源链交易')} value={<CopyShortHashButton value={job.sourceTxid} />} />}
          {job.targetTxid && <LedgerRow label={ct('Target transaction', '目标链交易')} value={<CopyShortHashButton value={job.targetTxid} />} />}
          <LedgerRow label={ct('Actual fees', '实际费用')} value={joinFeeText(fees.totalBtcSats, fees.totalMvcSats)} />
          <LedgerRow label={ct('Total duration', '总耗时')} value={formatLongDuration(completedDurationMs)} />
        </div>
        <div className="flex flex-wrap gap-[6px]">
          <button
            type="button"
            className={TK_CHIP_BTN}
            onClick={() => dispatchSuiteComposerDraft(ct(`Show my ${job.targetSymbol} balance on ${chainLabel(job.targetChain)}.`, `请查看我在 ${chainLabel(job.targetChain)} 上的 ${job.targetSymbol} 余额。`))}
          >
            {ct('View balance', '查看余额')}
          </button>
          <button
            type="button"
            className={TK_CHIP_BTN}
            onClick={() => dispatchSuiteComposerDraft(ct(`List my ${job.targetSymbol} for sale.`, `请帮我将 ${job.targetSymbol} 挂牌出售。`))}
          >
            {ct('List for sale', '挂牌出售')}
          </button>
          <button
            type="button"
            className={TK_CHIP_BTN}
            onClick={() => dispatchSuiteComposerDraft(ct(`Bridge ${job.amountDisplay} ${job.symbol} from ${chainLabel(job.sourceChain)} to ${chainLabel(job.targetChain)} again.`, `请再次将 ${job.amountDisplay} ${job.symbol} 从 ${chainLabel(job.sourceChain)} 桥接到 ${chainLabel(job.targetChain)}。`))}
          >
            {ct('Bridge again', '再次桥接')}
          </button>
        </div>
      </>
    );
  } else if (effectiveState === 'failed') {
    const reason = job.error ? ct(job.error.messageEn, job.error.messageZh) : ct('The bridge did not complete.', '桥接没有完成。');
    body = (
      <>
        <BridgeArcHero job={job} mode="quote" now={now} />
        <div className="text-[15px] font-extrabold tracking-[-0.02em]">{ct('Bridge did not complete', '桥接没有完成')}</div>
        <DownBox>{reason}</DownBox>
        {job.error?.fundsMoved ? (
          <div className={`${TK_INSET_BOX} flex flex-col gap-[6px] text-[12px]`}>
            <div className="leading-[1.45] text-[#5b6472] dark:text-[#9aa3b2]">
              {ct('Source funds were sent; keep this order id for Octopus support.', '源链资金已转出；请保留这个订单号用于联系 Octopus 支持。')}
            </div>
            {job.orderId && <LedgerRow label={ct('Order id', '订单号')} value={<span className="font-mono text-[11px]">{job.orderId}</span>} />}
            {job.sourceTxid && <LedgerRow label={ct('Source transaction', '源链交易')} value={<CopyShortHashButton value={job.sourceTxid} />} />}
          </div>
        ) : (
          <div className="text-[12px] leading-[1.45] text-[#5b6472] dark:text-[#9aa3b2]">
            {ct('No funds were moved.', '资金未转出。')}
          </div>
        )}
        <div className="flex flex-wrap gap-[6px]">
          <button
            type="button"
            className={TK_CHIP_BTN}
            onClick={() => dispatchSuiteComposerDraft(ct(`Quote this bridge again: ${job.amountDisplay} ${job.symbol} from ${chainLabel(job.sourceChain)} to ${chainLabel(job.targetChain)}.`, `请重新报价这笔桥接：${job.amountDisplay} ${job.symbol} 从 ${chainLabel(job.sourceChain)} 到 ${chainLabel(job.targetChain)}。`))}
          >
            {ct('Quote again', '重新报价')}
          </button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <BridgeArcHero job={job} mode="quote" now={now} />
        <div className="text-[15px] font-extrabold tracking-[-0.02em]">{ct('Quote expired', '报价已过期')}</div>
        <WarnBox>
          {ct('The 10 minute quote validity period has ended. Fees may have changed; refresh the quote before confirming.', '10 分钟报价有效期已结束。费率可能已变化，需要重新获取报价后才能确认。')}
        </WarnBox>
        <QuoteSummaryRows job={job} fees={fees} />
        {!readOnly && (
          <>
            {actionErrorBox}
            <button
              type="button"
              aria-label={ct('Refresh bridge quote', '刷新桥接报价')}
              disabled={busyAction !== null}
              onClick={onRefresh}
              className={TK_BTN_PRIMARY}
            >
              {busyAction === 'refresh' ? ct('Refreshing…', '刷新中…') : ct('Refresh quote', '刷新报价')}
            </button>
          </>
        )}
      </>
    );
  }

  return (
    <div data-asset-bridge-card="true" data-state={effectiveState} data-mode={mode} className={`${TK_CARD_SHELL} flex flex-col gap-[10px]`} aria-live="polite">
      {body}
    </div>
  );
};

export interface AssetBridgeCardProps {
  data: AssetBridgeCardFenceData;
}

const AssetBridgeCard: React.FC<AssetBridgeCardProps> = ({ data }) => {
  const { job, loading, now, reload, setJob } = useAssetBridgeJob(data.jobId);
  const [busyAction, setBusyAction] = useState<BridgeAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const expiredFetchRef = useRef<string | null>(null);

  useEffect(() => {
    expiredFetchRef.current = null;
  }, [data.jobId]);

  useEffect(() => {
    if (!job || job.state !== 'quote' || job.quoteExpiresAt <= 0 || now < job.quoteExpiresAt) return;
    if (expiredFetchRef.current === job.jobId) return;
    expiredFetchRef.current = job.jobId;
    void reload();
  }, [job, now, reload]);

  const runAction = useCallback(async (action: BridgeAction) => {
    const api = assetBridgeApi();
    if (!api) return;
    setBusyAction(action);
    setActionError(null);
    try {
      const result = action === 'confirm'
        ? await api.confirm({ jobId: data.jobId })
        : action === 'cancel'
          ? await api.cancel({ jobId: data.jobId })
          : await api.refreshQuote({ jobId: data.jobId });
      if (result.job) setJob(result.job);
      if (!result.ok) setActionError(result.error || ct('The action did not complete.', '操作没有完成。'));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : ct('The action did not complete.', '操作没有完成。'));
    } finally {
      setBusyAction(null);
    }
  }, [data.jobId, setJob]);

  const apiMissing = typeof window === 'undefined' || !window.electron?.assetBridge;
  const mode: AssetBridgeCardMode = apiMissing
    ? 'snapshot-missing-api'
    : !loading && job === null
      ? 'snapshot-not-found'
      : 'live';

  const displayJob = job ?? snapshotJobFromCard(data);
  if (loading && !apiMissing) {
    return (
      <div data-asset-bridge-card="true" data-state="loading" className={`${TK_CARD_SHELL} flex flex-col gap-[10px]`}>
        <BridgeArcHero job={displayJob} mode="quote" now={now} />
        <div className="text-center text-[12px] text-[#8a94a6] dark:text-[#6f7887]">{ct('Loading bridge quote…', '正在读取桥接报价…')}</div>
      </div>
    );
  }

  return (
    <AssetBridgeCardView
      job={displayJob}
      snapshot={data}
      now={now}
      mode={mode}
      busyAction={busyAction}
      actionError={actionError}
      onConfirm={() => void runAction('confirm')}
      onCancel={() => void runAction('cancel')}
      onRefresh={() => void runAction('refresh')}
    />
  );
};

export default AssetBridgeCard;
