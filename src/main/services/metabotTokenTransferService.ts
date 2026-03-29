import Decimal from 'decimal.js';
import type { MetabotStore } from '../metabotStore';
import type { Mrc20Asset } from './mrc20Service';
import type { MvcFtAsset } from './mvcFtService';
import { executeMrc20Transfer } from './mrc20Service';
import { executeMvcFtTransfer } from './mvcFtService';

export type TokenTransferAsset = Mrc20Asset | MvcFtAsset;
export type TokenTransferKind = TokenTransferAsset['kind'];

export interface TokenTransferDraftInput {
  kind: TokenTransferKind;
  metabotId: number;
  asset: TokenTransferAsset;
  toAddress: string;
  amount: string;
  feeRate: number;
}

export interface TokenTransferPreview {
  fromAddress: string;
  toAddress: string;
  amount: string;
  amountUnit: string;
  feeEstimated: string;
  feeEstimatedUnit: string;
  chainSymbol: 'BTC' | 'SPACE';
  feeRate: number;
}

const SATOSHIS_PER_UNIT = 100_000_000;
const MRC20_ESTIMATED_VBYTES = 360;
const MVC_FT_ESTIMATED_VBYTES = 250;

function normalizeAmount(input: string, decimal: number): string {
  const text = String(input ?? '').trim();
  if (!text) throw new Error('amount is required');
  const parsed = new Decimal(text);
  if (!parsed.isFinite() || parsed.lte(0)) throw new Error('amount must be positive');
  return parsed.toFixed(decimal);
}

function estimateFeeValue(kind: TokenTransferKind, feeRate: number): string {
  if (!Number.isFinite(feeRate) || feeRate <= 0) throw new Error('feeRate must be positive');
  const sats = kind === 'mrc20' ? MRC20_ESTIMATED_VBYTES * feeRate : MVC_FT_ESTIMATED_VBYTES * feeRate;
  return new Decimal(sats).div(SATOSHIS_PER_UNIT).toFixed(8);
}

export function getTokenTransferChain(kind: TokenTransferKind): 'btc' | 'mvc' {
  return kind === 'mrc20' ? 'btc' : 'mvc';
}

export function buildTokenTransferPreview(input: TokenTransferDraftInput): TokenTransferPreview {
  if (!input?.asset) throw new Error('asset is required');
  if (!input?.toAddress?.trim()) throw new Error('toAddress is required');

  const amount = normalizeAmount(input.amount, input.asset.decimal);
  const feeEstimatedUnit = input.kind === 'mrc20' ? 'BTC' : 'SPACE';

  return {
    fromAddress: input.asset.address,
    toAddress: input.toAddress.trim(),
    amount,
    amountUnit: input.asset.symbol,
    feeEstimated: estimateFeeValue(input.kind, input.feeRate),
    feeEstimatedUnit,
    chainSymbol: feeEstimatedUnit,
    feeRate: input.feeRate,
  };
}

export async function executeTokenTransfer(store: MetabotStore, input: TokenTransferDraftInput): Promise<{
  txId: string;
  commitTxId?: string;
  revealTxId?: string;
  rawTx?: string;
}> {
  if (input.kind === 'mrc20') {
    const asset = input.asset as Mrc20Asset;
    const result = await executeMrc20Transfer(store, {
      metabotId: input.metabotId,
      asset: {
        mrc20Id: asset.mrc20Id,
        decimal: asset.decimal,
        address: asset.address,
        symbol: asset.symbol,
      },
      toAddress: input.toAddress,
      amount: input.amount,
      feeRate: input.feeRate,
    });
    return {
      txId: result.revealTxId,
      commitTxId: result.commitTxId,
      revealTxId: result.revealTxId,
    };
  }

  const asset = input.asset as MvcFtAsset;
  const result = await executeMvcFtTransfer(store, {
    metabotId: input.metabotId,
    asset: {
      symbol: asset.symbol,
      genesis: asset.genesis,
      codeHash: asset.codeHash,
      decimal: asset.decimal,
      address: asset.address,
    },
    toAddress: input.toAddress,
    amount: input.amount,
    feeRate: input.feeRate,
  });

  return {
    txId: result.txId,
    rawTx: result.rawTx,
  };
}
