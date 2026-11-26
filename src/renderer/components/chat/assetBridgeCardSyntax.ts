/**
 * DOM-free protocol syntax for the built-in Octopus asset bridge.
 *
 * The card fence is a display snapshot only. Main-process actions always read
 * the persisted job row; this parser is deliberately strict about job ids so a
 * model-emitted fence can never become an authority for owner-confirmed funds.
 */

export const ASSET_BRIDGE_CARD_FENCE_TAG = 'asset-bridge-card';
export const ASSET_BRIDGE_NOTICE_FENCE_TAG = 'asset-bridge-notice';

export type AssetBridgeScenario = 'btc_mint' | 'mrc20_mint' | 'btc_redeem' | 'mrc20_redeem';
export type AssetBridgeChain = 'btc' | 'mvc';
export type AssetBridgeStandard = 'native' | 'mrc20' | 'mvc-ft';
export type AssetBridgeState = 'quote' | 'signing' | 'bridging' | 'completed' | 'failed' | 'expired' | 'cancelled';
export type AssetBridgeStage = 'confirming' | 'paying_out' | null;

export interface AssetBridgeFeeBreakdown {
  serviceBtcSats: number;
  serviceMvcSats: number;
  bridgeMinerBtcSats: number;
  bridgeMinerMvcSats: number;
  walletMinerBtcSats: number;
  walletMinerMvcSats: number;
  totalBtcSats: number;
  totalMvcSats: number;
  btcFeeRate: number;
  walletMinerMvcEstimated: boolean;
}

export interface AssetBridgeBlocker {
  code:
    | 'insufficient_asset'
    | 'insufficient_btc_fee'
    | 'insufficient_mvc_fee'
    | 'below_minimum'
    | 'above_maximum'
    | 'precision'
    | 'pool_cap'
    | 'direction_disabled';
  messageEn: string;
  messageZh: string;
}

export interface AssetBridgeJobView {
  jobId: string;
  metabotId: number;
  metabotName: string;
  sessionId: string;
  scenario: AssetBridgeScenario;
  sourceChain: AssetBridgeChain;
  targetChain: AssetBridgeChain;
  sourceStandard: AssetBridgeStandard;
  targetStandard: AssetBridgeStandard;
  symbol: string;
  targetSymbol: string;
  amountDisplay: string;
  receiveAmountDisplay: string;
  fromAddress: string;
  receiveAddress: string;
  btcAddress: string;
  mvcAddress: string;
  fees: AssetBridgeFeeBreakdown;
  balances: {
    sourceAssetDisplay: string;
    btcSats: number;
    mvcSats: number;
  };
  blockers: AssetBridgeBlocker[];
  poolCapDisplay: string | null;
  eta: {
    blocks: number;
    blockChain: AssetBridgeChain;
    minutes: number;
  };
  quoteExpiresAt: number;
  state: AssetBridgeState;
  stage: AssetBridgeStage;
  orderId: string | null;
  sourceTxid: string | null;
  targetTxid: string | null;
  requiredConfirmations: number | null;
  confirmations: number | null;
  lastConfirmationAt: number | null;
  broadcastAt: number | null;
  completedAt: number | null;
  feesPaid: AssetBridgeFeeBreakdown | null;
  error: {
    messageEn: string;
    messageZh: string;
    fundsMoved: boolean;
  } | null;
  notice: {
    requeued?: boolean;
  } | null;
  onComplete: string | null;
  updatedAt: number;
}

export interface AssetBridgeCardFenceData {
  v: 1;
  jobId: string;
  scenario: AssetBridgeScenario;
  symbol: string;
  targetSymbol: string;
  amountDisplay: string;
  state: AssetBridgeState;
}

export interface AssetBridgeNoticeFenceData {
  v: 1;
  jobId: string;
  status: 'completed' | 'failed';
  scenario: AssetBridgeScenario;
  symbol: string;
  targetSymbol: string;
  amountDisplay: string;
  targetChain: AssetBridgeChain;
  durationSec: number;
  targetTxid?: string;
  reasonEn?: string;
  reasonZh?: string;
}

const JOB_ID_RE = /^ab_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SCENARIOS = new Set<AssetBridgeScenario>(['btc_mint', 'mrc20_mint', 'btc_redeem', 'mrc20_redeem']);
const STATES = new Set<AssetBridgeState>(['quote', 'signing', 'bridging', 'completed', 'failed', 'expired', 'cancelled']);
const CHAINS = new Set<AssetBridgeChain>(['btc', 'mvc']);

function cleanStr(value: unknown, maxLen = 160): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLen);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(raw ?? '').trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function isAssetBridgeCardFenceLanguage(lang: string | undefined | null): boolean {
  return String(lang ?? '').trim().toLowerCase() === ASSET_BRIDGE_CARD_FENCE_TAG;
}

export function isAssetBridgeNoticeFenceLanguage(lang: string | undefined | null): boolean {
  return String(lang ?? '').trim().toLowerCase() === ASSET_BRIDGE_NOTICE_FENCE_TAG;
}

export function isAssetBridgeJobId(value: unknown): value is string {
  return typeof value === 'string' && JOB_ID_RE.test(value);
}

export function formatAssetBridgeCardFence(data: AssetBridgeCardFenceData): string {
  return `\`\`\`${ASSET_BRIDGE_CARD_FENCE_TAG}\n${JSON.stringify(data)}\n\`\`\``;
}

export function formatAssetBridgeNoticeFence(data: AssetBridgeNoticeFenceData): string {
  return `\`\`\`${ASSET_BRIDGE_NOTICE_FENCE_TAG}\n${JSON.stringify(data)}\n\`\`\``;
}

export function buildAssetBridgeCardFence(job: Pick<AssetBridgeJobView, 'jobId' | 'scenario' | 'symbol' | 'targetSymbol' | 'amountDisplay' | 'state'>): string {
  return formatAssetBridgeCardFence({
    v: 1,
    jobId: job.jobId,
    scenario: job.scenario,
    symbol: job.symbol,
    targetSymbol: job.targetSymbol,
    amountDisplay: job.amountDisplay,
    state: job.state,
  });
}

export function parseAssetBridgeCardFence(raw: string): AssetBridgeCardFenceData | null {
  const obj = parseJsonObject(raw);
  if (!obj || obj.v !== 1) return null;
  const jobId = cleanStr(obj.jobId, 80);
  const scenario = cleanStr(obj.scenario, 24) as AssetBridgeScenario;
  const state = cleanStr(obj.state, 24) as AssetBridgeState;
  const symbol = cleanStr(obj.symbol, 32);
  const targetSymbol = cleanStr(obj.targetSymbol, 32);
  const amountDisplay = cleanStr(obj.amountDisplay, 64);
  if (!isAssetBridgeJobId(jobId) || !SCENARIOS.has(scenario) || !STATES.has(state)) return null;
  if (!symbol || !targetSymbol || !amountDisplay) return null;
  return { v: 1, jobId, scenario, symbol, targetSymbol, amountDisplay, state };
}

export function parseAssetBridgeNoticeFence(raw: string): AssetBridgeNoticeFenceData | null {
  const obj = parseJsonObject(raw);
  if (!obj || obj.v !== 1) return null;
  const jobId = cleanStr(obj.jobId, 80);
  const statusRaw = cleanStr(obj.status, 16);
  const scenario = cleanStr(obj.scenario, 24) as AssetBridgeScenario;
  const targetChain = cleanStr(obj.targetChain, 8) as AssetBridgeChain;
  const symbol = cleanStr(obj.symbol, 32);
  const targetSymbol = cleanStr(obj.targetSymbol, 32);
  const amountDisplay = cleanStr(obj.amountDisplay, 64);
  const durationSec = Math.floor(Number(obj.durationSec));
  if (!isAssetBridgeJobId(jobId) || (statusRaw !== 'completed' && statusRaw !== 'failed')) return null;
  if (!SCENARIOS.has(scenario) || !CHAINS.has(targetChain) || !symbol || !targetSymbol || !amountDisplay) return null;
  if (!Number.isFinite(durationSec) || durationSec < 0) return null;
  const targetTxid = cleanStr(obj.targetTxid, 80);
  const reasonEn = cleanStr(obj.reasonEn, 240);
  const reasonZh = cleanStr(obj.reasonZh, 240);
  return {
    v: 1,
    jobId,
    status: statusRaw,
    scenario,
    symbol,
    targetSymbol,
    amountDisplay,
    targetChain,
    durationSec,
    ...(targetTxid ? { targetTxid } : {}),
    ...(reasonEn ? { reasonEn } : {}),
    ...(reasonZh ? { reasonZh } : {}),
  };
}
