/**
 * BTC network MetaID PIN (inscribe) logic. Used by createPinWorker when network is 'btc'.
 * Leverages BtcWallet.signTx(INSCRIBE_METAIDPIN) from @metalet/utxo-wallet-service
 * which handles the Commit+Reveal Taproot inscription internally.
 */

import {
  BtcWallet,
  AddressType,
  CoinType,
  SignType,
} from '@metalet/utxo-wallet-service';
import { fetchBtcUtxos, broadcastBtcTx } from './btcApi';

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";

function debugLog(msg: string): void {
  try {
    process.stderr.write(`[btc-inscribe] ${msg}\n`);
  } catch { /* noop */ }
}

function parseAddressIndexFromPath(pathStr: string): number {
  if (!pathStr || typeof pathStr !== 'string') return 0;
  const m = pathStr.match(/\/0\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

function getBtcWalletForWorker(mnemonic: string, pathStr: string): BtcWallet {
  const network = 'livenet' as const;
  const addressIndex = parseAddressIndexFromPath(pathStr || DEFAULT_PATH);
  return new BtcWallet({
    mnemonic,
    network,
    addressIndex,
    addressType: AddressType.SameAsMvc,
    coinType: CoinType.MVC,
  });
}

export interface BtcMetaidData {
  body?: string | Buffer;
  operation: 'init' | 'create' | 'modify' | 'revoke';
  path?: string;
  contentType?: string;
  encryption?: '0' | '1' | '2';
  version?: string;
  encoding?: BufferEncoding;
  revealAddr: string;
}

export async function runBtcCreatePin(
  mnemonic: string,
  pathStr: string,
  metaidData: {
    operation: string;
    path?: string;
    encryption?: string;
    version?: string;
    contentType?: string;
    payload: string;
    encoding?: 'utf-8' | 'base64';
  },
  feeRate: number
): Promise<{ success: boolean; txids: string[]; pinId: string; totalCost: number; error?: string }> {
  const encoding = metaidData.encoding === 'base64' ? 'base64' : 'utf-8';
  const body = Buffer.from(metaidData.payload, encoding);

  const wallet = getBtcWalletForWorker(mnemonic, pathStr);
  const address = wallet.getAddress();
  const scriptType = (wallet as any).getScriptType?.() ?? 'P2PKH';

  debugLog(`address=${address} scriptType=${scriptType} feeRate=${feeRate} sat/vB`);

  const needRawTx = scriptType === 'P2PKH';
  const rawUtxos = await fetchBtcUtxos(address, needRawTx);

  debugLog(`utxoCount=${rawUtxos.length} totalSats=${rawUtxos.reduce((s, u) => s + u.satoshis, 0)}`);

  if (rawUtxos.length === 0) {
    throw new Error('No BTC UTXOs available');
  }

  const utxos = rawUtxos.map((u) => ({
    txId: u.txId,
    outputIndex: u.outputIndex,
    satoshis: u.satoshis,
    address: u.address || address,
    rawTx: u.rawTx,
    confirmed: u.confirmed,
  }));

  const bodyStr = encoding === 'base64' ? body.toString('utf-8') : metaidData.payload;

  const metaidDataForSdk = {
    operation: metaidData.operation as 'init' | 'create' | 'modify' | 'revoke',
    path: metaidData.path,
    contentType: metaidData.contentType || 'application/json',
    encryption: (metaidData.encryption || '0') as '0' | '1' | '2',
    version: metaidData.version || '0.0.1',
    body: bodyStr,
    revealAddr: address,
  };

  debugLog(`calling BtcWallet.signTx(INSCRIBE_METAIDPIN) with feeRate=${feeRate}`);

  let signResult: any;
  try {
    signResult = wallet.signTx(SignType.INSCRIBE_METAIDPIN, {
      utxos,
      feeRate,
      metaidDataList: [metaidDataForSdk],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    debugLog(`signTx FAIL: ${msg}`);
    throw new Error(`BTC signTx failed: ${msg}`);
  }

  const { commitTx, revealTxs } = signResult;
  if (!commitTx?.rawTx) {
    throw new Error('BTC signTx returned no commitTx');
  }

  debugLog(`commitTx txId=${commitTx.txId} size=${commitTx.rawTx.length / 2}`);
  debugLog(`revealTxs count=${revealTxs?.length ?? 0}`);

  // Broadcast commit
  debugLog('broadcasting commit tx...');
  try {
    await broadcastBtcTx(commitTx.rawTx);
    debugLog('commit tx broadcast ok');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    debugLog(`commit tx broadcast FAIL: ${msg}`);
    throw e;
  }

  // Broadcast reveal(s)
  const revealTxIds: string[] = [];
  let totalCost = 0;
  for (let i = 0; i < (revealTxs ?? []).length; i++) {
    const reveal = revealTxs[i];
    debugLog(`broadcasting reveal tx#${i} size=${reveal.rawTx?.length / 2}...`);
    try {
      const revealTxId = await broadcastBtcTx(reveal.rawTx);
      revealTxIds.push(revealTxId);
      debugLog(`reveal tx#${i} broadcast ok txId=${revealTxId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      debugLog(`reveal tx#${i} broadcast FAIL: ${msg}`);
      throw e;
    }
    totalCost += reveal.fee ?? 0;
  }
  totalCost += commitTx.fee ?? 0;

  const pinId = revealTxIds[0] ? `${revealTxIds[0]}i0` : '';
  debugLog(`success pinId=${pinId} totalCost=${totalCost}`);

  return { success: true, txids: revealTxIds, pinId, totalCost };
}
