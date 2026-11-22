/**
 * MVC NFT trade worker (sell / cancelSell / buy): runs in subprocess via
 * ELECTRON_RUN_AS_NODE to avoid meta-contract "instanceof" issues in the
 * Electron main process (same pattern as buildMvcNftTransferRawTxWorker).
 *
 * All three NftManager trade operations mint TWO chained transactions and the
 * library broadcasts them in order: the first tx (sell: contract funding;
 * cancelSell/buy: unlock check) goes out first, the second tx carries the
 * final on-chain state (the sell listing / the cancel / the purchase). With
 * noBroadcast the worker returns both hex blobs so the parent can broadcast
 * stage 1 then stage 2 and own retries:
 *   sell:      { fundingTxHex, txHex, txid }      (txid = sell listing utxo tx)
 *   cancelSell { checkTxHex, txHex, txid }        (txid = cancel tx)
 *   buy:       { checkTxHex, txHex, txid }        (txid = purchase tx)
 */

import { API_NET, API_TARGET, NftManager, mvc } from 'meta-contract';
import { getMvcWallet, parseAddressIndexFromPath } from '../services/metabotWalletService';
import {
  attachMvcFundingSignatureContext,
  selectMvcFundingUtxos,
} from '../services/tokenTransferAdapters';
import {
  attachResilientMvcNftApi,
  fetchMvcFundingUtxos,
} from './mvcNftWorkerApi';

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";
// sell/cancelSell/buy all reject funding sets larger than 3 UTXOs.
const MAX_TRADE_FUNDING_UTXOS = 3;

type TradeAction = 'sell' | 'cancelSell' | 'buy';

function logStep(message: string, details?: Record<string, unknown>): void {
  try {
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    process.stderr.write(`[buildMvcNftTradeRawTxWorker] ${message}${suffix}\n`);
  } catch {
    // ignore logging failures
  }
}

function getMessage(err: unknown): string {
  if (err != null && typeof err === 'object' && 'message' in err && typeof (err as Error).message === 'string') {
    return (err as Error).message;
  }
  return String(err);
}

function normalizeExcludeOutpoints(input: unknown): Set<string> {
  if (!Array.isArray(input)) return new Set();
  return new Set(
    input
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((value) => /^[0-9a-f]{64}:\d+$/.test(value)),
  );
}

function spentOutpointsOf(txHex: string): string[] {
  const tx = new mvc.Transaction(txHex);
  return tx.inputs.map(
    (input: any) => `${input.prevTxId.toString('hex')}:${Number(input.outputIndex)}`,
  );
}

async function main(): Promise<void> {
  const mnemonic = process.env.IDBOTS_METABOT_MNEMONIC?.trim();
  const pathStr = (process.env.IDBOTS_METABOT_PATH || DEFAULT_PATH).trim();
  if (!mnemonic) {
    console.log(JSON.stringify({ success: false, error: 'IDBOTS_METABOT_MNEMONIC required' }));
    process.exit(1);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
    action: TradeAction;
    genesis: string;
    codehash: string;
    tokenIndex: string;
    price?: number;
    sellUtxo?: {
      txId: string;
      outputIndex: number;
      sellerAddress?: string;
      price?: number;
    };
    feeRate: number;
    excludeOutpoints?: string[];
  };

  const action = String(payload.action || '').trim() as TradeAction;
  if (action !== 'sell' && action !== 'cancelSell' && action !== 'buy') {
    console.log(JSON.stringify({ success: false, error: 'action must be sell, cancelSell, or buy' }));
    process.exit(1);
  }
  const genesis = String(payload.genesis || '').trim();
  const codehash = String(payload.codehash || '').trim();
  const tokenIndex = String(payload.tokenIndex || '').trim();
  const feeRate = Number(payload.feeRate);
  if (!genesis || !codehash || !/^\d+$/.test(tokenIndex) || !Number.isFinite(feeRate) || feeRate <= 0) {
    console.log(JSON.stringify({ success: false, error: 'Invalid payload for MVC NFT trade raw tx worker' }));
    process.exit(1);
  }

  let price: number | undefined;
  if (action === 'sell') {
    price = Number(payload.price);
    // Mirrors the NftManager.sell guard so callers get the same message before
    // any UTXO work happens.
    if (!Number.isFinite(price) || price < 22000) {
      console.log(JSON.stringify({ success: false, error: 'Selling Price must be greater than or equals to 22000 satoshis. 销售价格最低为22000聪。' }));
      process.exit(1);
    }
  }

  const sellUtxoInput = payload.sellUtxo && String(payload.sellUtxo.txId || '').trim() && Number.isInteger(Number(payload.sellUtxo.outputIndex))
    ? {
        txId: String(payload.sellUtxo.txId).trim(),
        outputIndex: Number(payload.sellUtxo.outputIndex),
        sellerAddress: String(payload.sellUtxo.sellerAddress || '').trim(),
        price: Number(payload.sellUtxo.price) || 0,
      }
    : undefined;

  const addressIndex = parseAddressIndexFromPath(pathStr);
  const mvcWallet = await getMvcWallet(mnemonic, addressIndex);
  const traderWif = mvcWallet.getPrivateKey();
  const traderAddress = mvcWallet.getAddress();

  const excludeOutpoints = normalizeExcludeOutpoints(payload.excludeOutpoints);
  const allUtxos = await fetchMvcFundingUtxos(traderAddress, { logStep });
  let utxos = allUtxos
    .map((utxo) => ({
      txId: String(utxo.txid || '').trim(),
      outputIndex: Number(utxo.outIndex),
      satoshis: Number(utxo.value),
      height: Number(utxo.height),
      address: traderAddress,
    }))
    .filter((utxo) => {
      const key = `${utxo.txId.toLowerCase()}:${utxo.outputIndex}`;
      return /^[0-9a-f]{64}$/i.test(utxo.txId) && Number.isInteger(utxo.outputIndex) && utxo.outputIndex >= 0 && utxo.satoshis > 600 && !excludeOutpoints.has(key);
    });
  utxos = attachMvcFundingSignatureContext(utxos, {
    senderWif: traderWif,
    senderAddress: traderAddress,
  });
  utxos = selectMvcFundingUtxos(utxos, { maxCount: MAX_TRADE_FUNDING_UTXOS });
  logStep('Fetched MVC NFT trade funding candidates', {
    action,
    candidateOutpoints: utxos.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
    excludedOutpoints: Array.from(excludeOutpoints),
  });
  if (utxos.length === 0) {
    console.log(JSON.stringify({ success: false, error: 'No spendable MVC UTXOs after exclusions' }));
    process.exit(1);
  }

  const nftManager = new NftManager({
    network: API_NET.MAIN,
    apiTarget: API_TARGET.APIMVC,
    purse: traderWif,
    feeb: feeRate,
  });
  attachResilientMvcNftApi(nftManager, {
    holderAddress: action === 'sell' ? traderAddress : (sellUtxoInput?.sellerAddress || traderAddress),
    sellUtxo: sellUtxoInput ? { txId: sellUtxoInput.txId, outputIndex: sellUtxoInput.outputIndex } : undefined,
    network: API_NET.MAIN,
    logStep,
  });

  const baseParams = {
    genesis,
    codehash,
    tokenIndex,
    utxos,
    noBroadcast: true as const,
  };

  if (action === 'sell') {
    const result = await nftManager.sell({
      ...baseParams,
      sellerWif: traderWif,
      price: price as number,
    });
    // sellTxHex funds the sell contract; txHex moves the NFT into it. The
    // final sell listing utxo lives in txid (the second broadcast).
    const fundingSpentOutpoints = spentOutpointsOf(result.sellTxHex);
    console.log(
      JSON.stringify({
        success: true,
        action,
        fundingTxHex: result.sellTxHex,
        fundingTxid: result.sellTxId,
        txHex: result.txHex,
        txid: result.txid,
        fundingSpentOutpoints,
        spentOutpoints: Array.from(new Set([...fundingSpentOutpoints, ...spentOutpointsOf(result.txHex)])),
      }),
    );
    logStep('Built MVC NFT sell raw txs locally', {
      fundingTxid: result.sellTxId,
      txid: result.txid,
    });
    return;
  }

  if (action === 'cancelSell') {
    const result = await nftManager.cancelSell({
      ...baseParams,
      sellerWif: traderWif,
      ...(sellUtxoInput ? { sellUtxo: sellUtxoInput } : {}),
    });
    // unlockCheckTxHex goes out first; txHex carries the cancel (NFT back to
    // the seller) and its id is the final tx.
    const checkSpentOutpoints = spentOutpointsOf(result.unlockCheckTxHex);
    console.log(
      JSON.stringify({
        success: true,
        action,
        fundingTxHex: result.unlockCheckTxHex,
        fundingTxid: result.unlockCheckTxId,
        txHex: result.txHex,
        txid: result.txid,
        fundingSpentOutpoints: checkSpentOutpoints,
        spentOutpoints: Array.from(new Set([...checkSpentOutpoints, ...spentOutpointsOf(result.txHex)])),
      }),
    );
    logStep('Built MVC NFT cancelSell raw txs locally', {
      fundingTxid: result.unlockCheckTxId,
      txid: result.txid,
    });
    return;
  }

  const result = await nftManager.buy({
    ...baseParams,
    buyerWif: traderWif,
    buyerAddress: traderAddress,
    ...(sellUtxoInput ? { sellUtxo: sellUtxoInput } : {}),
  });
  const checkSpentOutpoints = spentOutpointsOf(result.unlockCheckTxHex);
  console.log(
    JSON.stringify({
      success: true,
      action: 'buy',
      fundingTxHex: result.unlockCheckTxHex,
      fundingTxid: result.unlockCheckTxId,
      txHex: result.txHex,
      txid: result.txid,
      fundingSpentOutpoints: checkSpentOutpoints,
      spentOutpoints: Array.from(new Set([...checkSpentOutpoints, ...spentOutpointsOf(result.txHex)])),
    }),
  );
  logStep('Built MVC NFT buy raw txs locally', {
    fundingTxid: result.unlockCheckTxId,
    txid: result.txid,
  });
}

if (require.main === module) {
  main().catch((err: unknown) => {
    const errorPayload = JSON.stringify({ success: false, error: getMessage(err) });
    console.log(errorPayload);
    console.error(errorPayload);
    process.exit(1);
  });
}
