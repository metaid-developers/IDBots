/** Built-in Octopus asset bridge quote/sign/track service. */

import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { MetabotStore } from '../metabotStore';
import { OctopusBridgeClient, type OctopusAssetListData, type OctopusAssetPair, type OctopusCreatedOrder, type OctopusOrderStatusView } from './octopusBridgeClient';
import { AssetBridgeStore, type AssetBridgeJobRecord } from './assetBridgeStore';
import type { SqliteDatabase } from '../sqliteTypes';
import {
  type AssetBridgeJobView,
  type AssetBridgeScenario,
  type AssetBridgeBlocker,
  type AssetBridgeFeeBreakdown,
} from '../../renderer/components/chat/assetBridgeCardSyntax';
import {
  deriveAssetBridgeWalletContext,
  signAssetBridgeScenario,
  signBtcBridgeSend,
  calculateBtcMintMaxAmount,
  type AssetBridgeSignerDeps,
} from './assetBridgeSigner';
import { executeMrc20Transfer, listMrc20Assets } from './mrc20Service';
import { listMvcFtAssets } from './mvcFtService';
import { fetchMvcAddressUtxos } from './mvcFundingRecoveryService';
import { fetchBtcUtxosForTransfer } from './transferService';
import { getWalletTxStatus } from './walletTxStatusService';
import { summarizeRawTx } from './btcMultisigScript';

const QUOTE_TTL_MS = 10 * 60_000;
const POLL_FAST_MS = 30_000;
const POLL_SLOW_MS = 5 * 60_000;
const SLOW_AFTER_MS = 6 * 60 * 60_000;
const BTC_DUST_MIN = 1000;

function nowMs(): number { return Date.now(); }
function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function ceilFee(base: unknown): number { return Math.ceil(num(base, 0) * 1.05); }
function dec(value: unknown): Decimal {
  try { return new Decimal(String(value ?? '0')); } catch { return new Decimal(0); }
}
function displayFromBase(base: string, decimals: number): string {
  return dec(base).div(new Decimal(10).pow(decimals)).toString();
}
function baseFromDisplay(display: string, decimals: number): string {
  return dec(display).mul(new Decimal(10).pow(decimals)).toFixed(0);
}
function hasPrecisionOverflow(display: string, decimals: number): boolean {
  const parts = String(display).trim().split('.');
  return !!parts[1] && parts[1].length > decimals;
}
function confirmNumberBySeqAndAmount(
  amount: number,
  seq: Array<[number, number | null | undefined, number, number]> | undefined,
  side: 'BTC' | 'MRC20' | 'MVC',
): number {
  if (!Array.isArray(seq) || seq.length === 0) return side === 'MVC' ? 1 : 2;
  for (const item of seq) {
    const [start, end, confirmBtc, confirmMvc] = item;
    if (end !== null && end !== undefined) {
      if (start <= amount && amount <= end) return side === 'MVC' ? confirmMvc : confirmBtc;
    } else if (start <= amount) return side === 'MVC' ? confirmMvc : confirmBtc;
  }
  return side === 'MVC' ? 1 : 2;
}
function errMsg(error: unknown): string {
  return error && typeof error === 'object' && typeof (error as Error).message === 'string' ? (error as Error).message : String(error ?? '');
}
function blocker(code: AssetBridgeBlocker['code'], en: string, zh: string): AssetBridgeBlocker {
  return { code, messageEn: en, messageZh: zh };
}
function zeroFees(btcFeeRate: number): AssetBridgeFeeBreakdown {
  return { serviceBtcSats: 0, serviceMvcSats: 0, bridgeMinerBtcSats: 0, bridgeMinerMvcSats: 0, walletMinerBtcSats: 0, walletMinerMvcSats: 0, totalBtcSats: 0, totalMvcSats: 0, btcFeeRate, walletMinerMvcEstimated: true };
}
function totals(fees: AssetBridgeFeeBreakdown): AssetBridgeFeeBreakdown {
  fees.totalBtcSats = Math.ceil(fees.serviceBtcSats + fees.bridgeMinerBtcSats + fees.walletMinerBtcSats);
  fees.totalMvcSats = Math.ceil(fees.serviceMvcSats + fees.bridgeMinerMvcSats + fees.walletMinerMvcSats);
  return fees;
}

export interface AssetBridgeServiceDeps {
  client?: OctopusBridgeClient;
  signerDeps?: AssetBridgeSignerDeps;
  deriveWalletContext?: typeof deriveAssetBridgeWalletContext;
  listMrc20Assets?: typeof listMrc20Assets;
  listMvcFtAssets?: typeof listMvcFtAssets;
  fetchBtcUtxos?: typeof fetchBtcUtxosForTransfer;
  fetchMvcUtxos?: typeof fetchMvcAddressUtxos;
  signBtc?: typeof signBtcBridgeSend;
  signScenario?: typeof signAssetBridgeScenario;
  executeMrc20Transfer?: typeof executeMrc20Transfer;
  getWalletTxStatus?: typeof getWalletTxStatus;
  emitJobUpdated?: (view: AssetBridgeJobView) => void;
  notifyJob?: (record: AssetBridgeJobRecord, targetSessionId: string) => Promise<void> | void;
  wakeOnComplete?: (record: AssetBridgeJobRecord, targetSessionId: string) => Promise<void> | void;
  resolveNoticeSession?: (record: AssetBridgeJobRecord) => string;
  now?: () => number;
  saveDb?: () => void;
}

export interface CreateAssetBridgeQuoteInput {
  sessionId: string;
  metabotId: number;
  asset: string;
  fromChain: 'btc' | 'mvc';
  amount: string;
  onComplete?: string | null;
  btcFeeRate?: number;
}

interface ResolvedScenario {
  scenario: AssetBridgeScenario;
  pair: OctopusAssetPair;
  network: 'BTC' | 'MRC20';
  direction: 'mint' | 'redeem';
}

export class AssetBridgeService {
  readonly store: AssetBridgeStore;
  private readonly client: OctopusBridgeClient;
  private readonly deps: AssetBridgeServiceDeps;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly metabotStore: MetabotStore,
    db: SqliteDatabase,
    deps: AssetBridgeServiceDeps = {},
  ) {
    this.store = new AssetBridgeStore(db, deps.saveDb);
    this.client = deps.client ?? new OctopusBridgeClient();
    this.deps = deps;
    this.now = deps.now ?? nowMs;
  }

  private emit(view: AssetBridgeJobView): void {
    this.deps.emitJobUpdated?.(structuredClone(view));
  }

  private save(record: AssetBridgeJobRecord): void {
    record.view.updatedAt = this.now();
    this.store.update(record.view.jobId, { view: record.view });
    this.emit(record.view);
  }

  private applyLazyExpiry(record: AssetBridgeJobRecord | null): AssetBridgeJobRecord | null {
    if (record?.view.state === 'quote' && record.view.quoteExpiresAt <= this.now()) {
      record.view.state = 'expired';
      this.save(record);
    }
    return record;
  }

  get(jobId: string): AssetBridgeJobView | null {
    return this.applyLazyExpiry(this.store.get(jobId))?.view ?? null;
  }

  getRecord(jobId: string): AssetBridgeJobRecord | null {
    return this.applyLazyExpiry(this.store.get(jobId));
  }

  listByMetabot(metabotId: number, limit = 5): AssetBridgeJobView[] {
    return this.store.listByMetabot(metabotId, limit).map((record) => this.applyLazyExpiry(record)?.view).filter(Boolean) as AssetBridgeJobView[];
  }

  resolveScenario(assetList: OctopusAssetListData, assetInput: string, fromChain: 'btc' | 'mvc'): ResolvedScenario {
    const asset = String(assetInput || '').trim().replace(/^\$+/, '');
    const pairs = assetList.assetList ?? [];
    const btcPair = pairs.find((pair) => pair.network === 'BTC');
    if (asset.toUpperCase() === 'BTC' && fromChain === 'btc') {
      if (!btcPair) throw new Error(`Unknown asset ${assetInput}. Supported: ${this.supportedSymbols(assetList).join(', ')}`);
      return { scenario: 'btc_mint', pair: btcPair, network: 'BTC', direction: 'mint' };
    }
    if ((asset.toUpperCase() === 'BTC' || asset.toUpperCase() === 'WBTC') && fromChain === 'mvc') {
      if (!btcPair) throw new Error(`Unknown asset ${assetInput}. Supported: ${this.supportedSymbols(assetList).join(', ')}`);
      return { scenario: 'btc_redeem', pair: btcPair, network: 'BTC', direction: 'redeem' };
    }
    const pair = pairs.find((candidate) => candidate.network === 'MRC20' && candidate.originSymbol.toUpperCase() === asset.toUpperCase());
    if (!pair) throw new Error(`Unknown asset ${assetInput}. Supported: ${this.supportedSymbols(assetList).join(', ')}`);
    return {
      scenario: fromChain === 'btc' ? 'mrc20_mint' : 'mrc20_redeem',
      pair,
      network: 'MRC20',
      direction: fromChain === 'btc' ? 'mint' : 'redeem',
    };
  }

  supportedSymbols(assetList: OctopusAssetListData): string[] {
    const symbols = new Set<string>();
    for (const pair of assetList.assetList ?? []) {
      symbols.add(pair.network === 'BTC' ? 'BTC/WBTC' : pair.originSymbol);
    }
    return Array.from(symbols);
  }

  async createQuote(input: CreateAssetBridgeQuoteInput): Promise<AssetBridgeJobView> {
    if (!input.sessionId) throw new Error('sessionId is required');
    if (!Number.isInteger(input.metabotId) || input.metabotId <= 0) throw new Error('metabotId is required');
    if (!input.amount?.trim()) throw new Error('amount is required');
    const assetList = await this.client.assetList();
    const resolved = this.resolveScenario(assetList, input.asset, input.fromChain);
    return await this.buildQuoteJob(input, assetList, resolved, `ab_${randomUUID()}`);
  }

  private async buildQuoteJob(input: CreateAssetBridgeQuoteInput, assetList: OctopusAssetListData, resolved: ResolvedScenario, jobId: string, capture?: AssetBridgeJobRecord[]): Promise<AssetBridgeJobView> {
    const context = await (this.deps.deriveWalletContext ?? deriveAssetBridgeWalletContext)(this.metabotStore, input.metabotId);
    const btcFeeRate = Math.max(1, num(input.btcFeeRate, num(assetList.feeBtc, 2)));
    const quote = await this.client.feeQuote({
      network: resolved.network,
      direction: resolved.direction,
      originTokenId: resolved.pair.originTokenId,
      btcFeeRate,
    });
    const btcUtxos = await (this.deps.fetchBtcUtxos ?? fetchBtcUtxosForTransfer)(context.btcAddress).catch(() => []);
    const mvcUtxos = await (this.deps.fetchMvcUtxos ?? fetchMvcAddressUtxos)(context.mvcAddress).catch(() => []);
    const btcSats = (btcUtxos as any[]).reduce((sum: number, utxo: any) => sum + num(utxo.satoshis), 0);
    const mvcSats = (mvcUtxos as any[]).reduce((sum: number, utxo: any) => sum + num(utxo.satoshis), 0);
    const precisionDecimals = Math.max(0, num(resolved.pair.decimals) - num(resolved.pair.trimDecimals));
    const mrc20Assets = await (this.deps.listMrc20Assets ?? listMrc20Assets)(context.btcAddress).catch(() => []);
    const ftAssets = await (this.deps.listMvcFtAssets ?? listMvcFtAssets)(context.mvcAddress).catch(() => []);
    const mrc20Asset = mrc20Assets.find((asset) => asset.mrc20Id === resolved.pair.originTokenId);
    const ftAsset = ftAssets.find((asset) => asset.genesis === resolved.pair.targetTokenGenesis || asset.codeHash === resolved.pair.targetTokenCodeHash);

    const isMint = resolved.direction === 'mint';
    const isBtcPair = resolved.network === 'BTC';
    const sourceStandard = resolved.scenario === 'btc_mint' ? 'native' : resolved.scenario === 'mrc20_mint' ? 'mrc20' : 'mvc-ft';
    const targetStandard = resolved.scenario === 'btc_redeem' ? 'native' : resolved.scenario === 'mrc20_redeem' ? 'mrc20' : 'mvc-ft';
    const sourceAssetDisplay = resolved.scenario === 'btc_mint'
      ? dec(btcSats).div(1e8).toFixed(8)
      : resolved.scenario === 'mrc20_mint'
        ? String(mrc20Asset?.balance.display ?? '0')
        : String(ftAsset?.balance.display ?? '0');

    const serviceBtc = isMint ? num(quote.btcFeeSats) : num(quote.btcServiceFeeSats);
    const serviceMvc = isMint ? 0 : num(quote.mvcServiceFeeSats);
    const bridgeMinerBtc = isMint ? 0 : num(quote.btcBridgeMinerFeeSats) + num(quote.btcPostageSats);
    const bridgeMinerMvc = isMint ? 0 : num(quote.mvcBridgeMinerFeeSats);
    const walletMinerMvc = isMint ? 0 : Math.max(0, num(quote.estNetworkMinerMvcSats) - num(quote.mvcBridgeMinerFeeSats));
    const blockers: AssetBridgeBlocker[] = [];
    let amountDisplay = String(input.amount).trim();
    let amountSats = 0;
    let amountBaseUnits = '0';

    const requestedMax = amountDisplay.toLowerCase() === 'max';
    if (requestedMax) {
      if (resolved.scenario === 'btc_mint') {
        try {
          amountSats = await calculateBtcMintMaxAmount({
            context,
            serviceAddress: quote.btcFeeAddress,
            serviceSats: Math.ceil(serviceBtc),
            feeRate: btcFeeRate,
            utxos: btcUtxos as any,
          });
        } catch {
          const roughFee = Math.max(BTC_DUST_MIN, Math.ceil(btcUtxos.length * 148 * btcFeeRate + 2 * 34 * btcFeeRate + 10 * btcFeeRate));
          amountSats = Math.max(0, btcSats - serviceBtc - roughFee);
        }
        amountDisplay = dec(amountSats).div(1e8).toFixed(8);
      } else if (resolved.scenario === 'mrc20_mint') {
        amountDisplay = sourceAssetDisplay;
      } else {
        amountDisplay = sourceAssetDisplay;
      }
    }

    if (resolved.scenario === 'btc_mint') {
      amountSats = requestedMax ? amountSats : Math.floor(dec(amountDisplay).mul(1e8).toNumber());
      amountDisplay = dec(amountSats).div(1e8).toFixed(8);
    } else if (resolved.scenario === 'mrc20_mint') {
      amountBaseUnits = amountDisplay;
    } else {
      amountBaseUnits = baseFromDisplay(amountDisplay, precisionDecimals);
      if (resolved.scenario === 'btc_redeem') amountSats = Math.floor(num(amountBaseUnits));
    }

    if (!dec(amountDisplay).isFinite() || dec(amountDisplay).lte(0)) {
      blockers.push(blocker('insufficient_asset', 'Amount must be positive.', '数量必须大于 0。'));
    }
    if ((resolved.scenario === 'mrc20_mint' || resolved.scenario === 'mrc20_redeem') && hasPrecisionOverflow(amountDisplay, precisionDecimals)) {
      blockers.push(blocker('precision', `Amount supports at most ${precisionDecimals} decimal places.`, `数量最多支持 ${precisionDecimals} 位小数。`));
    }
    if (dec(amountDisplay).gt(dec(sourceAssetDisplay))) {
      blockers.push(blocker('insufficient_asset', `Need ${amountDisplay}, available ${sourceAssetDisplay}.`, `需要 ${amountDisplay}，当前可用 ${sourceAssetDisplay}。`));
    }

    if (isBtcPair) {
      const min = num(assetList.amountLimitMinimum, 0);
      const max = num(assetList.amountLimitMaximum, Infinity);
      if (amountSats && amountSats < Math.max(min, BTC_DUST_MIN)) blockers.push(blocker('below_minimum', `Need at least ${Math.max(min, BTC_DUST_MIN)} sats, entered ${amountSats} sats.`, `至少需要 ${Math.max(min, BTC_DUST_MIN)} sats，当前为 ${amountSats} sats。`));
      if (amountSats && amountSats > max) blockers.push(blocker('above_maximum', `Maximum is ${max} sats, entered ${amountSats} sats.`, `最大为 ${max} sats，当前为 ${amountSats} sats。`));
    }
    const poolCapDisplay = typeof quote.maxSingleMintAmount === 'string' ? quote.maxSingleMintAmount : null;
    if (resolved.scenario === 'mrc20_mint' && poolCapDisplay && dec(amountDisplay).gt(dec(poolCapDisplay))) {
      blockers.push(blocker('pool_cap', `Pool liquidity allows at most ${poolCapDisplay}, entered ${amountDisplay}.`, `池子流动性最多支持 ${poolCapDisplay}，当前为 ${amountDisplay}。`));
    }

    if ((isMint && resolved.pair.isEnableMint === false) || (!isMint && resolved.pair.isEnableRedeem === false) || (isMint && assetList.mintPaused)) {
      const raw = isMint && assetList.mintPaused ? String(assetList.mintPausedMessage || 'Mint is paused') : 'This bridge direction is disabled';
      blockers.push(blocker('direction_disabled', raw, raw));
    }

    const fees = totals({
      ...zeroFees(btcFeeRate),
      serviceBtcSats: Math.ceil(serviceBtc),
      serviceMvcSats: Math.ceil(serviceMvc),
      bridgeMinerBtcSats: Math.ceil(bridgeMinerBtc),
      bridgeMinerMvcSats: Math.ceil(bridgeMinerMvc),
      walletMinerMvcSats: Math.ceil(walletMinerMvc),
      walletMinerMvcEstimated: !isMint,
    });

    // Exact BTC miner-fee dry-runs where possible. A funds failure is a quote blocker, not an exception.
    if (blockers.length === 0) {
      try {
        const signBtc = this.deps.signBtc ?? signBtcBridgeSend;
        if (resolved.scenario === 'btc_mint') {
          const dry = await signBtc({
            context,
            outputs: [
              { address: quote.btcFeeAddress, satoshis: Math.max(BTC_DUST_MIN, amountSats) },
              { address: quote.btcFeeAddress, satoshis: Math.max(BTC_DUST_MIN, Math.ceil(serviceBtc)) },
            ],
            feeRate: btcFeeRate,
            utxos: btcUtxos as any,
          });
          fees.walletMinerBtcSats = dry.feeSats;
        } else if (resolved.scenario === 'mrc20_mint') {
          const execute = this.deps.executeMrc20Transfer ?? executeMrc20Transfer;
          const dry = await execute(this.metabotStore, {
            metabotId: input.metabotId,
            asset: {
              mrc20Id: resolved.pair.originTokenId,
              decimal: Math.max(0, num(resolved.pair.decimals)),
              address: context.btcAddress,
              symbol: resolved.pair.originSymbol,
            },
            toAddress: quote.btcFeeAddress,
            amount: amountDisplay,
            feeRate: btcFeeRate,
          }, undefined, {
            service: { address: quote.btcFeeAddress, satoshis: Math.ceil(serviceBtc) },
            dryRun: true,
          });
          fees.walletMinerBtcSats = Math.ceil(num(dry.totalFeeSats));
        } else {
          const dry = await signBtc({
            context,
            outputs: [{ address: quote.btcFeeAddress, satoshis: Math.max(BTC_DUST_MIN, Math.ceil(serviceBtc + bridgeMinerBtc)) }],
            feeRate: btcFeeRate,
            utxos: btcUtxos as any,
          });
          fees.walletMinerBtcSats = dry.feeSats;
        }
      } catch (error) {
        const message = errMsg(error);
        if (/insufficient|No BTC UTXOs|inscription-carrier|outputs below/i.test(message)) {
          blockers.push(blocker('insufficient_btc_fee', `Need BTC for fees; available ${btcSats} sats.`, `BTC 手续费不足；当前可用 ${btcSats} sats。`));
        } else if (/Not enough MRC20 UTXOs|No MRC20 UTXOs/i.test(message)) {
          blockers.push(blocker('insufficient_asset', `Need ${amountDisplay}, available ${sourceAssetDisplay}.`, `需要 ${amountDisplay}，当前可用 ${sourceAssetDisplay}。`));
        } else {
          throw error;
        }
      }
    }
    totals(fees);

    if (btcSats < fees.totalBtcSats + (resolved.scenario === 'btc_mint' ? amountSats : 0)) {
      blockers.push(blocker('insufficient_btc_fee', `Need ${fees.totalBtcSats + (resolved.scenario === 'btc_mint' ? amountSats : 0)} sats BTC including source/fees, available ${btcSats} sats.`, `含源资产和费用共需 ${fees.totalBtcSats + (resolved.scenario === 'btc_mint' ? amountSats : 0)} sats BTC，当前可用 ${btcSats} sats。`));
    }
    if (!isMint && mvcSats < fees.totalMvcSats) {
      blockers.push(blocker('insufficient_mvc_fee', `Need ${fees.totalMvcSats} sats MVC for fees, available ${mvcSats} sats.`, `MVC 手续费共需 ${fees.totalMvcSats} sats，当前可用 ${mvcSats} sats。`));
    }

    const confirmationAmount = resolved.scenario === 'btc_mint' ? amountSats : resolved.scenario === 'btc_redeem' ? num(amountBaseUnits) : 0;
    const seqSide = resolved.network === 'BTC' ? (isMint ? 'BTC' : 'MVC') : isMint ? 'MRC20' : 'MVC';
    let blocks = confirmNumberBySeqAndAmount(confirmationAmount, assetList.confirmSequence, seqSide as any);
    if (resolved.scenario === 'mrc20_mint') blocks = Math.max(blocks, 3);
    const metabot = this.metabotStore.getMetabotById(input.metabotId);
    const symbol = isBtcPair ? (fromChainIsBtc(resolved) ? 'BTC' : 'WBTC') : resolved.pair.originSymbol;
    const targetSymbol = isBtcPair ? (fromChainIsBtc(resolved) ? 'WBTC' : 'BTC') : resolved.pair.targetSymbol;
    const receiveAmountDisplay = amountDisplay;
    const view: AssetBridgeJobView = {
      jobId,
      metabotId: input.metabotId,
      metabotName: String((metabot as any)?.name || `MetaBot ${input.metabotId}`),
      sessionId: input.sessionId,
      scenario: resolved.scenario,
      sourceChain: isMint ? 'btc' : 'mvc',
      targetChain: isMint ? 'mvc' : 'btc',
      sourceStandard: sourceStandard as any,
      targetStandard: targetStandard as any,
      symbol,
      targetSymbol,
      amountDisplay,
      receiveAmountDisplay,
      fromAddress: isMint ? context.btcAddress : context.mvcAddress,
      receiveAddress: isMint ? context.mvcAddress : context.btcAddress,
      btcAddress: context.btcAddress,
      mvcAddress: context.mvcAddress,
      fees,
      balances: { sourceAssetDisplay, btcSats, mvcSats },
      blockers,
      poolCapDisplay,
      eta: { blocks, blockChain: isMint ? 'btc' : 'mvc', minutes: blocks * 10 + 1 },
      quoteExpiresAt: this.now() + QUOTE_TTL_MS,
      state: 'quote',
      stage: null,
      orderId: null,
      sourceTxid: null,
      targetTxid: null,
      requiredConfirmations: null,
      confirmations: null,
      lastConfirmationAt: null,
      broadcastAt: null,
      completedAt: null,
      feesPaid: null,
      error: null,
      notice: null,
      onComplete: input.onComplete?.trim() || null,
      updatedAt: this.now(),
    };
    const record: AssetBridgeJobRecord = {
      view,
      metabotId: input.metabotId,
      sessionId: input.sessionId,
      originTokenId: resolved.pair.originTokenId,
      quoteJson: { input, quote, pair: resolved.pair, amountBaseUnits, amountSats, precisionDecimals, publicKey: context.publicKey, publicKeySign: context.publicKeySign },
      orderJson: null,
      signedJson: null,
      notifiedAt: null,
      noticeSessionId: null,
      createdAt: this.now(),
    };
    if (capture) {
      capture.push(record);
    } else {
      this.store.insert(record);
      this.emit(view);
    }
    return structuredClone(view);
  }

  async refreshQuote(jobId: string): Promise<{ ok: boolean; job?: AssetBridgeJobView; error?: string }> {
    try {
      const record = this.applyLazyExpiry(this.store.get(jobId));
      if (!record || (record.view.state !== 'quote' && record.view.state !== 'expired')) throw new Error('Only quote or expired jobs can be refreshed');
      const input = record.quoteJson.input as CreateAssetBridgeQuoteInput;
      const assetList = await this.client.assetList();
      const resolved = this.resolveScenario(assetList, input.asset, input.fromChain);
      // Rebuild into a fresh row shape, then preserve identity/state fields.
      const temp = await this.buildQuotePreviewOnly(input, assetList, resolved, jobId);
      const { __quoteJson: refreshedQuoteJson, ...tempView } = temp as AssetBridgeJobView & { __quoteJson?: Record<string, unknown> };
      record.view = { ...tempView, jobId, state: 'quote', updatedAt: this.now() };
      record.quoteJson = { ...record.quoteJson, ...(refreshedQuoteJson ?? {}) };
      this.store.update(jobId, { view: record.view, quoteJson: record.quoteJson });
      this.emit(record.view);
      return { ok: true, job: structuredClone(record.view) };
    } catch (error) {
      return { ok: false, error: errMsg(error) };
    }
  }

  private async buildQuotePreviewOnly(input: CreateAssetBridgeQuoteInput, assetList: OctopusAssetListData, resolved: ResolvedScenario, jobId: string): Promise<AssetBridgeJobView & { __quoteJson?: unknown }> {
    const captured: AssetBridgeJobRecord[] = [];
    await this.buildQuoteJob(input, assetList, resolved, jobId, captured);
    if (!captured.length) throw new Error('Failed to rebuild quote');
    const view = captured[0].view as AssetBridgeJobView & { __quoteJson?: unknown };
    view.__quoteJson = captured[0].quoteJson;
    return view;
  }

  cancel(jobId: string): { ok: boolean; job?: AssetBridgeJobView; error?: string } {
    const record = this.applyLazyExpiry(this.store.get(jobId));
    if (!record) return { ok: false, error: 'job not found' };
    if (record.view.state !== 'quote') return { ok: false, error: 'Only an unconfirmed quote can be cancelled' };
    record.view.state = 'cancelled';
    this.save(record);
    return { ok: true, job: structuredClone(record.view) };
  }

  async confirm(jobId: string): Promise<{ ok: boolean; job?: AssetBridgeJobView; error?: string }> {
    const record = this.applyLazyExpiry(this.store.get(jobId));
    if (!record) return { ok: false, error: 'job not found' };
    if (record.view.state !== 'quote') return { ok: false, error: 'Quote is no longer confirmable' };
    if (record.view.blockers.length) return { ok: false, error: record.view.blockers[0].messageEn };
    record.view.state = 'signing';
    this.save(record);
    try {
      const assetList = await this.client.assetList();
      const input = record.quoteJson.input as CreateAssetBridgeQuoteInput;
      const resolved = this.resolveScenario(assetList, input.asset, input.fromChain);
      if ((resolved.direction === 'mint' && resolved.pair.isEnableMint === false) || (resolved.direction === 'redeem' && resolved.pair.isEnableRedeem === false) || (resolved.direction === 'mint' && assetList.mintPaused)) {
        throw new Error('This bridge direction is no longer enabled');
      }
      const order = await this.client.createPrepayOrder(record.view.scenario, {
        amount: record.view.scenario === 'btc_mint' ? String(Math.floor(num(record.quoteJson.amountSats))) : record.view.scenario === 'mrc20_mint' ? record.view.amountDisplay : String(record.quoteJson.amountBaseUnits),
        originTokenId: record.originTokenId,
        addressType: 'P2PKH',
        publicKey: String(record.quoteJson.publicKey),
        publicKeySign: String(record.quoteJson.publicKeySign),
        publicKeyReceive: String(record.quoteJson.publicKey),
        publicKeyReceiveSign: String(record.quoteJson.publicKeySign),
        btcFeeRate: record.view.fees.btcFeeRate,
      });
      // Octopus btcFeeSats/mvcFeeSats are the total fee outputs: service fee
      // plus bridge-paid miner/postage components on redeem.
      const quotedBtc = Math.max(record.view.fees.serviceBtcSats + record.view.fees.bridgeMinerBtcSats, 0);
      const quotedMvc = Math.max(record.view.fees.serviceMvcSats + record.view.fees.bridgeMinerMvcSats, 0);
      const createdBtc = num(
        order.btcFeeSats,
        num(order.btcServiceFeeSats) + num(order.btcBridgeMinerFeeSats) + num(order.btcPostageSats),
      );
      const createdMvc = num(order.mvcFeeSats, num(order.mvcServiceFeeSats) + num(order.mvcBridgeMinerFeeSats));
      if (createdBtc > ceilFee(quotedBtc) || createdMvc > ceilFee(quotedMvc)) {
        record.view.state = 'quote';
        record.orderJson = null;
        this.store.update(jobId, { view: record.view, orderJson: null });
        await this.refreshQuote(jobId);
        const refreshed = this.store.get(jobId);
        if (refreshed) {
          refreshed.view.error = { messageEn: 'Fees changed; please confirm again', messageZh: '费用已变化，请重新确认', fundsMoved: false };
          this.save(refreshed);
          return { ok: false, job: structuredClone(refreshed.view), error: 'Fees changed; please confirm again' };
        }
        record.view.error = { messageEn: 'Fees changed; please confirm again', messageZh: '费用已变化，请重新确认', fundsMoved: false };
        this.save(record);
        return { ok: false, job: structuredClone(record.view), error: 'Fees changed; please confirm again' };
      }
      record.orderJson = order as Record<string, unknown>;
      record.view.orderId = order.orderId;
      const orderConfirmations = num(order.confirmNumber, record.view.eta.blocks);
      record.view.requiredConfirmations = record.view.scenario === 'mrc20_mint' ? Math.max(orderConfirmations, 3) : orderConfirmations;
      const context = await (this.deps.deriveWalletContext ?? deriveAssetBridgeWalletContext)(this.metabotStore, record.metabotId);
      const signer = this.deps.signScenario ?? signAssetBridgeScenario;
      let mrc20Submitted = false;
      const mrc20SubmitSigned = record.view.scenario === 'mrc20_mint'
        ? async (hexes: { commitTxHex: string; revealTxHex: string; totalFeeSats?: number }) => {
            const commitTxId = summarizeRawTx(hexes.commitTxHex).txid;
            const revealTxId = summarizeRawTx(hexes.revealTxHex).txid;
            record.signedJson = {
              scenario: record.view.scenario,
              sourceTxid: revealTxId,
              txHexList: [hexes.commitTxHex, hexes.revealTxHex],
              commitTxId,
              revealTxId,
            };
            record.view.sourceTxid = revealTxId;
            if (typeof hexes.totalFeeSats === 'number' && Number.isFinite(hexes.totalFeeSats)) {
              record.view.feesPaid = { ...record.view.fees, walletMinerBtcSats: Math.ceil(hexes.totalFeeSats), walletMinerMvcSats: 0 };
              totals(record.view.feesPaid);
            }
            this.store.update(jobId, { view: record.view, orderJson: record.orderJson, signedJson: record.signedJson });
            try {
              await this.client.submitPrepayOrder('mrc20_mint', { orderId: order.orderId, txHexList: [hexes.commitTxHex, hexes.revealTxHex] });
            } catch (submitError) {
              // Because this submit happens inside the MRC-20 signing flow,
              // apply the same server-persistence resume rule here that the
              // outer submit path applies for the other three scenarios.
              try {
                const status = await this.client.getOrderStatus(order.orderId);
                if (status.kind === 'ok' && status.data.sourceTxid) {
                  record.view.sourceTxid = status.data.sourceTxid;
                  mrc20Submitted = true;
                  return { commitTxId, revealTxId };
                }
              } catch {
                // best effort only; rethrow the original submit failure
              }
              throw submitError;
            }
            mrc20Submitted = true;
            return { commitTxId, revealTxId };
          }
        : undefined;
      const signed = await signer({
        store: this.metabotStore,
        metabotId: record.metabotId,
        scenario: record.view.scenario,
        context,
        order: {
          bridgeAddress: order.bridgeAddress,
          btcFeeSats: num(order.btcFeeSats, num(order.btcServiceFeeSats)),
          btcFeeAddress: String(order.btcFeeAddress || ''),
          mvcFeeSats: num(order.mvcFeeSats, num(order.mvcServiceFeeSats)),
          mvcFeeAddress: String(order.mvcFeeAddress || ''),
          btcFeeRate: num(order.btcFeeRate, record.view.fees.btcFeeRate),
        },
        amount: record.view.scenario === 'btc_mint' ? String(Math.floor(num(record.quoteJson.amountSats))) : record.view.amountDisplay,
        amountBaseUnits: String(record.quoteJson.amountBaseUnits),
        btcFeeRate: record.view.fees.btcFeeRate,
        mvcFeeRate: num(assetList.feeMvc, 1),
        token: { codeHash: resolved.pair.targetTokenCodeHash, genesis: resolved.pair.targetTokenGenesis, decimal: num(record.quoteJson.precisionDecimals) },
        mrc20TokenId: resolved.pair.originTokenId,
        mrc20Decimal: num(resolved.pair.decimals),
        walletMinerMvcSats: record.view.fees.walletMinerMvcSats,
        ...(mrc20SubmitSigned ? { mrc20SubmitSigned } : {}),
        deps: { ...(this.deps.signerDeps ?? {}), executeMrc20Transfer: this.deps.signerDeps?.executeMrc20Transfer ?? executeMrc20Transfer },
      } as any);
      record.signedJson = signed as unknown as Record<string, unknown>;
      record.view.sourceTxid = signed.sourceTxid || null;
      record.view.feesPaid = { ...record.view.fees, walletMinerBtcSats: Math.ceil(num(signed.walletMinerBtcSats)), walletMinerMvcSats: Math.ceil(num(signed.walletMinerMvcSats)) };
      totals(record.view.feesPaid);
      this.store.update(jobId, { view: record.view, orderJson: record.orderJson, signedJson: record.signedJson });
      this.emit(record.view);

      const submitInput: Record<string, unknown> = { orderId: order.orderId };
      if (record.view.scenario === 'btc_mint') submitInput.txHex = signed.txHex;
      else if (record.view.scenario === 'mrc20_mint') submitInput.txHexList = signed.txHexList;
      else Object.assign(submitInput, { txid: signed.txid, txHexList: signed.txHexList, mvcFeeTxHex: signed.mvcFeeTxHex, btcFeeTxHex: signed.btcFeeTxHex });
      try {
        if (!mrc20Submitted) await this.client.submitPrepayOrder(record.view.scenario, submitInput);
        this.markBridging(record);
        signed.postSubmit?.();
      } catch (submitError) {
        let serverTxid: string | null = null;
        try {
          const status = await this.client.getOrderStatus(order.orderId);
          if (status.kind === 'ok') serverTxid = status.data.sourceTxid;
        } catch {
          // best effort
        }
        if (serverTxid) {
          record.view.sourceTxid = serverTxid;
          console.warn(`[assetBridge] submit failed after server persisted source tx ${serverTxid}: ${errMsg(submitError)}`);
          this.markBridging(record);
        } else {
          this.failBeforeBroadcast(record, errMsg(submitError));
        }
      }
      const finalState = String(record.view.state);
      return { ok: finalState === 'bridging', job: structuredClone(record.view), error: finalState === 'bridging' ? undefined : record.view.error?.messageEn };
    } catch (error) {
      this.failBeforeBroadcast(record, errMsg(error));
      return { ok: false, job: structuredClone(record.view), error: record.view.error?.messageEn || errMsg(error) };
    }
  }

  private failBeforeBroadcast(record: AssetBridgeJobRecord, message: string): void {
    record.view.state = 'failed';
    record.view.error = { messageEn: message || 'Bridge failed before broadcast', messageZh: message || '桥接在广播前失败', fundsMoved: false };
    this.save(record);
  }

  private markBridging(record: AssetBridgeJobRecord): void {
    const at = this.now();
    record.view.state = 'bridging';
    record.view.stage = 'confirming';
    record.view.confirmations = 0;
    record.view.broadcastAt = at;
    record.view.lastConfirmationAt = at;
    this.save(record);
    this.startPolling();
  }

  startPolling(): void {
    if (this.timer) return;
    const tick = async () => {
      const jobs = this.store.listByState('bridging');
      if (!jobs.length) {
        this.stopPolling();
        return;
      }
      await this.pollOnce();
      const hasSlow = jobs.some((job) => job.view.broadcastAt && this.now() - job.view.broadcastAt > SLOW_AFTER_MS);
      this.timer = setTimeout(tick, hasSlow ? POLL_SLOW_MS : POLL_FAST_MS);
      this.timer.unref?.();
    };
    this.timer = setTimeout(tick, 0);
    this.timer.unref?.();
  }

  stopPolling(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async recoverStartup(): Promise<void> {
    for (const record of this.store.listByState('signing')) {
      try {
        if (record.orderJson?.orderId) {
          const status = await this.client.getOrderStatus(String(record.orderJson.orderId));
          if (status.kind === 'ok' && status.data.sourceTxid) {
            record.view.sourceTxid = status.data.sourceTxid;
            this.markBridging(record);
          } else this.failBeforeBroadcast(record, 'Interrupted before broadcast');
        } else this.failBeforeBroadcast(record, 'Interrupted before broadcast');
      } catch {
        this.failBeforeBroadcast(record, 'Interrupted before broadcast');
      }
    }
    if (this.store.listByState('bridging').length) this.startPolling();
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const record of this.store.listByState('bridging')) {
        try { await this.pollJob(record); } catch (error) { console.warn(`[assetBridge] poll ${record.view.jobId}: ${errMsg(error)}`); }
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollJob(record: AssetBridgeJobRecord): Promise<void> {
    if (!record.orderJson?.orderId) return;
    let status: OctopusOrderStatusView | null = null;
    const result = await this.client.getOrderStatus(String(record.orderJson.orderId));
    if (result.kind === 'ok') status = result.data;
    else if (result.kind === 'unsupported' && record.view.sourceTxid) {
      const rows = await this.client.queryTransactionsByAddress({
        type: record.view.scenario === 'btc_mint' ? 'btcToMvc' : record.view.scenario === 'mrc20_mint' ? 'mrc20ToMvc' : record.view.scenario === 'btc_redeem' ? 'mvcToBtc' : 'mvcToMrc20',
        address: record.view.fromAddress,
        size: 50,
      });
      const row = rows.find((candidate) => String(candidate.originTxid || '') === record.view.sourceTxid);
      if (row) {
        status = {
          stage: row.status === 'success' && row.targetTxid ? 'completed' : row.status === 'failed' ? 'failed' : 'confirming',
          targetTxid: typeof row.targetTxid === 'string' ? row.targetTxid : null,
          targetTxids: typeof row.targetTxid === 'string' ? [row.targetTxid] : [],
          failureReason: null,
          sourceConfirmations: null,
          requiredConfirmations: record.view.requiredConfirmations || record.view.eta.blocks,
        } as OctopusOrderStatusView;
      }
    }
    if (!status) return;
    const fingerprint = () => JSON.stringify({
      sourceTxid: record.view.sourceTxid,
      targetTxid: record.view.targetTxid,
      requiredConfirmations: record.view.requiredConfirmations,
      confirmations: record.view.confirmations,
      lastConfirmationAt: record.view.lastConfirmationAt,
      stage: record.view.stage,
      state: record.view.state,
      error: record.view.error,
    });
    const before = fingerprint();
    if (!record.view.sourceTxid && status.sourceTxid) record.view.sourceTxid = status.sourceTxid;
    if (typeof status.requiredConfirmations === 'number' && Number.isFinite(status.requiredConfirmations)) {
      record.view.requiredConfirmations = status.requiredConfirmations;
    }
    let confirmations = status.sourceConfirmations;
    if (record.view.sourceTxid) {
      try {
        const receiver = record.view.sourceChain === 'mvc' ? record.view.mvcAddress : record.view.receiveAddress;
        const tx = await (this.deps.getWalletTxStatus ?? getWalletTxStatus)({} as any, { chain: record.view.sourceChain, txid: record.view.sourceTxid, receiver });
        if (record.view.sourceChain === 'mvc') {
          if (tx.confirmed === true) confirmations = Math.max(1, tx.confirmations ?? 1);
        } else if (typeof tx.confirmations === 'number') {
          confirmations = tx.confirmations;
        }
      } catch {
        // fall back to server confirmations
      }
    }
    if (typeof confirmations === 'number') {
      if (record.view.sourceChain === 'mvc' && record.view.confirmations != null) {
        confirmations = Math.max(record.view.confirmations, confirmations);
      }
      if (record.view.confirmations == null || confirmations > record.view.confirmations) record.view.lastConfirmationAt = this.now();
      record.view.confirmations = confirmations;
    }
    record.view.targetTxid = status.targetTxid || record.view.targetTxid;
    if (status.stage === 'paying_out' || (typeof record.view.confirmations === 'number' && record.view.requiredConfirmations != null && record.view.confirmations >= record.view.requiredConfirmations)) {
      record.view.stage = 'paying_out';
    }
    if (status.targetTxid || status.stage === 'completed') {
      record.view.state = 'completed';
      record.view.stage = null;
      record.view.completedAt = this.now();
      this.save(record);
      await this.notifyOnce(record);
    } else if (status.stage === 'failed' || status.stage === 'cancelled' || status.status === 'failed' || status.status === 'cancel') {
      record.view.state = 'failed';
      record.view.stage = null;
      const reason = status.failureReason || 'Bridge order failed';
      record.view.error = { messageEn: reason, messageZh: reason, fundsMoved: true };
      this.save(record);
      await this.notifyOnce(record);
    } else if (fingerprint() !== before) {
      this.save(record);
    }
  }

  private async notifyOnce(record: AssetBridgeJobRecord): Promise<void> {
    if (record.notifiedAt) return;
    record.notifiedAt = this.now();
    const target = this.deps.resolveNoticeSession?.(record) ?? record.sessionId;
    record.noticeSessionId = target;
    this.store.update(record.view.jobId, { view: record.view, notifiedAt: record.notifiedAt, noticeSessionId: target });
    await this.deps.notifyJob?.(record, target);
    if (record.view.state === 'completed' && record.view.onComplete?.trim()) {
      await this.deps.wakeOnComplete?.(record, target);
    }
  }
}

function fromChainIsBtc(resolved: ResolvedScenario): boolean {
  return resolved.direction === 'mint';
}
