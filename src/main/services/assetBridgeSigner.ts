/** Signing primitives for the owner-confirmed Octopus asset bridge. */

import { BtcWallet, SignType } from '@metalet/utxo-wallet-service';
import type { MetabotStore } from '../metabotStore';
import { parseAddressIndexFromPath } from './metabotWalletService';
import { getBtcWalletForTransfer, fetchBtcUtxosForTransfer } from './transferService';
import { summarizeRawTx } from './btcMultisigScript';
import { isBtcSpendableSats, BTC_MIN_SPENDABLE_SATS } from './btcSpendPolicy';
import { buildMvcOrderedRawTxBundle } from './walletRawTxService';
import type { executeMrc20Transfer, ExecuteMrc20TransferOptions } from './mrc20Service';
import { recordMvcSpentOutpoints } from './mvcSpendSessionState';
import { recordMvcFtBundleSpendSession as defaultRecordMvcFtBundleSpendSession } from './mvcFtService';
import type { AssetBridgeScenario } from '../../renderer/components/chat/assetBridgeCardSyntax';

export interface AssetBridgeUtxo {
  txId: string;
  outputIndex: number;
  satoshis: number;
  address: string;
  rawTx?: string;
  confirmed?: boolean;
}

export interface AssetBridgeWalletContext {
  wallet: BtcWallet;
  btcAddress: string;
  mvcAddress: string;
  publicKey: string;
  publicKeySign: string;
  mnemonic: string;
  addressIndex: number;
}

export interface BtcSignedTx {
  txid: string;
  txHex: string;
  feeSats: number;
  outputs: Array<{ address: string; value: number }>;
  spentUtxos: AssetBridgeUtxo[];
}

export interface AssetBridgeSignerDeps {
  fetchBtcUtxos?: (address: string) => Promise<AssetBridgeUtxo[]>;
  deriveWalletContext?: (store: MetabotStore, metabotId: number) => Promise<AssetBridgeWalletContext>;
  executeMrc20Transfer?: typeof executeMrc20Transfer;
  buildMvcOrderedRawTxBundle?: (...args: any[]) => Promise<any>;
  recordMvcFtBundleSpendSession?: (...args: any[]) => void;
  recordMvcSpends?: (...args: any[]) => void;
}

function getErrorMessage(error: unknown): string {
  return error && typeof error === 'object' && typeof (error as Error).message === 'string'
    ? (error as Error).message
    : String(error ?? '');
}

export function makeStrandedOutputError(outputs: Array<{ value: number }>): Error {
  return new Error(
    `BTC transaction would create an output of ${outputs.map((output) => `${output.value} sats`).join(', ')}; outputs below ${BTC_MIN_SPENDABLE_SATS} sats cannot be spent under the inscription-carrier rule. Nothing was broadcast.`,
  );
}

export function auditBtcOutputsSpendable(rawTx: string): Array<{ address: string; value: number }> {
  const outputs = summarizeRawTx(rawTx).outputs.map((output) => ({ address: output.address || '', value: output.value }));
  const stranded = outputs.filter((output) => !isBtcSpendableSats(output.value));
  if (stranded.length > 0) throw makeStrandedOutputError(stranded);
  return outputs;
}

export async function deriveAssetBridgeWalletContext(store: MetabotStore, metabotId: number): Promise<AssetBridgeWalletContext> {
  const row = store.getMetabotWalletByMetabotId(metabotId);
  if (!row?.mnemonic?.trim()) throw new Error('MetaBot wallet not found');
  const addressIndex = parseAddressIndexFromPath(row.path || "m/44'/10001'/0'/0/0");
  const wallet = getBtcWalletForTransfer(row.mnemonic, addressIndex);
  const publicKey = Buffer.from(wallet.getPublicKey() as Uint8Array).toString('hex');
  const publicKeySign = await Promise.resolve(wallet.signMessage(publicKey, 'base64'));
  return {
    wallet,
    btcAddress: wallet.getAddress(),
    mvcAddress: wallet.getAddress(),
    publicKey,
    publicKeySign,
    mnemonic: row.mnemonic,
    addressIndex,
  };
}

export async function signBtcBridgeSend(params: {
  context: AssetBridgeWalletContext;
  outputs: Array<{ address: string; satoshis: number }>;
  feeRate: number;
  utxos?: AssetBridgeUtxo[];
}): Promise<BtcSignedTx> {
  const utxos = params.utxos ?? await fetchBtcUtxosForTransfer(params.context.btcAddress);
  if (!utxos.length) throw new Error('No BTC UTXOs available');
  const signed = params.context.wallet.signTx(SignType.SEND, {
    utxos: utxos as any,
    outputs: params.outputs,
    feeRate: params.feeRate,
    changeAddress: params.context.btcAddress,
  }) as unknown as { txId?: string; txid?: string; rawTx: string; fee?: number | string; txInputs?: Array<Record<string, unknown>> };
  const outputs = auditBtcOutputsSpendable(signed.rawTx);
  return {
    txid: signed.txId || signed.txid || '',
    txHex: signed.rawTx,
    feeSats: Math.ceil(Number(signed.fee ?? 0)),
    outputs,
    spentUtxos: [],
  };
}

/** Calculate the greatest SDK-signable no-change BTC mint amount for "max" quotes. */
export async function calculateBtcMintMaxAmount(params: {
  context: AssetBridgeWalletContext;
  serviceAddress: string;
  serviceSats: number;
  feeRate: number;
  utxos: AssetBridgeUtxo[];
}): Promise<number> {
  const total = params.utxos.reduce((sum, utxo) => sum + Math.max(0, Math.floor(Number(utxo.satoshis || 0))), 0);
  const serviceSats = Math.max(0, Math.floor(Number(params.serviceSats || 0)));
  if (!total || total <= serviceSats + 1) return 0;

  const trySign = (amount: number): { outputCount: number; actualFee: number } | null => {
    try {
      const signed = params.context.wallet.signTx(SignType.SEND, {
        utxos: params.utxos as any,
        outputs: [
          { address: params.serviceAddress, satoshis: Math.floor(amount) },
          { address: params.serviceAddress, satoshis: serviceSats },
        ],
        feeRate: params.feeRate,
        changeAddress: params.context.btcAddress,
      }) as unknown as { rawTx: string };
      const summary = summarizeRawTx(signed.rawTx);
      const outputTotal = summary.outputs.reduce((sum, output) => sum + output.value, 0);
      return { outputCount: summary.outputs.length, actualFee: total - outputTotal };
    } catch (error) {
      if (/insufficient funds/i.test(getErrorMessage(error))) return null;
      throw error;
    }
  };

  // Successful signability is monotonic in the bridge amount. Binary-search
  // the upper edge, then fold any change the edge transaction still carries
  // into the amount and repeat. The result is the largest amount the exact
  // production signer can spend with no change output.
  for (let round = 0; round < 4; round += 1) {
    let low = 1;
    let high = total - serviceSats - 1;
    let best = 0;
    let bestResult: { outputCount: number; actualFee: number } | null = null;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const result = trySign(mid);
      if (result) {
        best = mid;
        bestResult = result;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (!best || !bestResult) return 0;
    if (bestResult.outputCount <= 2) return Math.floor(best);
    const change = total - serviceSats - best - bestResult.actualFee;
    if (change <= 0) return Math.floor(best);
    const folded = best + change;
    const foldedResult = trySign(folded);
    if (foldedResult && foldedResult.outputCount <= 2) return Math.floor(folded);
    // If folding the change enters the SDK's dust/insufficient boundary, the
    // next binary round starts from the full range and settles at the highest
    // signable no-change edge below it.
  }
  return 0;
}

export interface AssetBridgeSignResult {
  scenario: AssetBridgeScenario;
  sourceTxid: string;
  txHex?: string;
  txHexList?: string[];
  txid?: string;
  mvcFeeTxHex?: string;
  btcFeeTxHex?: string;
  walletMinerBtcSats: number;
  walletMinerMvcSats: number;
  postSubmit?: () => void;
}

export async function signRedeemBridgeTransactions(params: {
  store: MetabotStore;
  metabotId: number;
  context: AssetBridgeWalletContext;
  bridgeAddress: string;
  amountBaseUnits: string;
  token: { codeHash: string; genesis: string };
  mvcFeeAddress: string;
  mvcFeeSats: number;
  btcFeeAddress: string;
  btcFeeSats: number;
  btcFeeRate: number;
  mvcFeeRate: number;
  walletMinerMvcSats?: number;
  btcUtxos?: AssetBridgeUtxo[];
  deps?: AssetBridgeSignerDeps;
}): Promise<AssetBridgeSignResult> {
  const buildBundle = params.deps?.buildMvcOrderedRawTxBundle ?? buildMvcOrderedRawTxBundle;
  const bundle = await buildBundle(params.store, {
    metabotId: params.metabotId,
    steps: [
      { kind: 'mvc_transfer', toAddress: params.mvcFeeAddress, amountSats: params.mvcFeeSats, feeRate: params.mvcFeeRate },
      {
        kind: 'mvc_ft_transfer',
        token: {
          codeHash: params.token.codeHash,
          genesisHash: params.token.genesis,
          tokenID: params.token.genesis,
          decimal: (params.token as { decimal?: number }).decimal,
        },
        toAddress: params.bridgeAddress,
        amount: params.amountBaseUnits,
        feeRate: params.mvcFeeRate,
        funding: { stepIndex: 0, useOutput: 'change' },
      },
    ],
  });
  const step0 = bundle.steps?.[0];
  const step1 = bundle.steps?.[1];
  const amountCheckRawTx = step1?.amountCheckRawTx || step1?.amount_check_raw_tx;
  const ftRawTx = step1?.raw_tx || step1?.rawTx;
  const txid = step1?.txid;
  if (!step0?.raw_tx && !step0?.rawTx) throw new Error('MVC service-fee transaction missing');
  if (!amountCheckRawTx || !ftRawTx || !txid) throw new Error('MVC token transfer transaction missing');
  const btc = await signBtcBridgeSend({
    context: params.context,
    outputs: [{ address: params.btcFeeAddress, satoshis: params.btcFeeSats }],
    feeRate: params.btcFeeRate,
    utxos: params.btcUtxos,
  });
  return {
    scenario: params.token.codeHash ? 'mrc20_redeem' : 'btc_redeem',
    sourceTxid: txid,
    txid,
    txHexList: [amountCheckRawTx, ftRawTx],
    mvcFeeTxHex: step0.raw_tx || step0.rawTx,
    btcFeeTxHex: btc.txHex,
    walletMinerBtcSats: btc.feeSats,
    walletMinerMvcSats: Math.max(0, Math.ceil(Number(params.walletMinerMvcSats ?? 0))),
    postSubmit: () => {
      try {
        const step0Spent = Array.isArray(step0?.spent_outpoints) ? step0.spent_outpoints : [];
        if (step0Spent.length) recordMvcSpentOutpoints(params.metabotId, step0Spent);
        const record = params.deps?.recordMvcFtBundleSpendSession ?? defaultRecordMvcFtBundleSpendSession;
        if (record) record({
          metabotId: params.metabotId,
          walletAddress: params.context.mvcAddress,
          amountCheckRawTx,
          rawTx: ftRawTx,
          txId: txid,
        });
      } catch {
        // cache priming is best-effort only
      }
    },
  };
}

export async function signAssetBridgeScenario(params: {
  store: MetabotStore;
  metabotId: number;
  scenario: AssetBridgeScenario;
  context: AssetBridgeWalletContext;
  order: {
    bridgeAddress: string;
    btcFeeSats?: number;
    btcFeeAddress?: string;
    mvcFeeSats?: number;
    mvcFeeAddress?: string;
    btcFeeRate?: number;
  };
  amount: string;
  amountBaseUnits?: string;
  btcFeeRate: number;
  mvcFeeRate?: number;
  token?: { codeHash: string; genesis: string };
  deps?: AssetBridgeSignerDeps;
  mrc20TokenId?: string;
  mrc20Decimal?: number;
  walletMinerMvcSats?: number;
  mrc20SubmitSigned?: ExecuteMrc20TransferOptions['submitSigned'];
}): Promise<AssetBridgeSignResult> {
  if (params.scenario === 'btc_mint') {
    const signed = await signBtcBridgeSend({
      context: params.context,
      outputs: [
        { address: params.order.bridgeAddress, satoshis: Math.floor(Number(params.amount)) },
        { address: String(params.order.btcFeeAddress), satoshis: Math.floor(Number(params.order.btcFeeSats)) },
      ],
      feeRate: params.btcFeeRate,
    });
    return {
      scenario: params.scenario,
      sourceTxid: signed.txid,
      txHex: signed.txHex,
      walletMinerBtcSats: signed.feeSats,
      walletMinerMvcSats: 0,
    };
  }
  if (params.scenario === 'mrc20_mint') {
    const execute = params.deps?.executeMrc20Transfer;
    if (!execute) throw new Error('MRC20 signing dependency unavailable');
    const result = await execute(params.store, {
      metabotId: params.metabotId,
      asset: {
        mrc20Id: params.mrc20TokenId || params.token?.genesis,
        decimal: Math.max(0, Math.floor(Number(params.mrc20Decimal ?? 0))),
        address: params.context.btcAddress,
        symbol: '',
      },
      toAddress: params.order.bridgeAddress,
      amount: params.amount,
      feeRate: params.btcFeeRate,
    }, undefined, {
      service: { address: String(params.order.btcFeeAddress), satoshis: Math.floor(Number(params.order.btcFeeSats)) },
      ...(params.mrc20SubmitSigned ? { submitSigned: params.mrc20SubmitSigned } : {}),
    });
    return {
      scenario: params.scenario,
      sourceTxid: result.revealTxId || '',
      txHexList: [result.commitTxHex, result.revealTxHex],
      walletMinerBtcSats: Math.ceil(Number(result.totalFeeSats ?? 0)),
      walletMinerMvcSats: 0,
      ...(params.mrc20SubmitSigned ? { submitted: true } : {}),
    } as AssetBridgeSignResult;
  }
  if (!params.token || !params.amountBaseUnits) throw new Error('token and base-unit amount are required for redeem signing');
  const redeemSigned = await signRedeemBridgeTransactions({
    store: params.store,
    metabotId: params.metabotId,
    context: params.context,
    bridgeAddress: params.order.bridgeAddress,
    amountBaseUnits: params.amountBaseUnits,
    token: params.token,
    mvcFeeAddress: String(params.order.mvcFeeAddress),
    mvcFeeSats: Math.floor(Number(params.order.mvcFeeSats)),
    btcFeeAddress: String(params.order.btcFeeAddress),
    btcFeeSats: Math.floor(Number(params.order.btcFeeSats)),
    btcFeeRate: params.btcFeeRate,
    mvcFeeRate: Math.max(1, Math.ceil(Number(params.mvcFeeRate ?? 1))),
    walletMinerMvcSats: params.walletMinerMvcSats,
    deps: params.deps,
  });
  redeemSigned.scenario = params.scenario;
  return redeemSigned;
}

export function signerErrorMessage(error: unknown): string {
  return getErrorMessage(error);
}
