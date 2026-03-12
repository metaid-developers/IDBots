/**
 * DOGE network MetaID PIN (inscribe) logic. Used by createPinWorker when network is 'doge'.
 * Ported from reference doge.ts; uses dogeApi for UTXO/fee/broadcast and @metalet/utxo-wallet-service for wallet.
 */

import * as bitcoin from 'bitcoinjs-lib';
import ECPairFactory, { ECPairAPI } from 'ecpair';
import {
  fetchDogeUtxos,
  broadcastDogeTx,
  fetchDogeFeeRates,
  type DogeUTXO,
} from './dogeApi';
import {
  DogeWallet,
  AddressType,
  CoinType,
} from '@metalet/utxo-wallet-service';

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";

function debugLog(msg: string): void {
  try {
    process.stderr.write(`[doge-inscribe] ${msg}\n`);
  } catch {
    /* noop */
  }
}

function parseAddressIndexFromPath(pathStr: string): number {
  if (!pathStr || typeof pathStr !== 'string') return 0;
  const m = pathStr.match(/\/0\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

async function getDogeWalletForWorker(mnemonic: string, pathStr: string): Promise<DogeWallet> {
  const network = 'livenet' as 'livenet';
  const addressIndex = parseAddressIndexFromPath(pathStr || DEFAULT_PATH);
  return new DogeWallet({
    mnemonic,
    network,
    addressIndex,
    addressType: AddressType.DogeSameAsMvc,
    coinType: CoinType.MVC,
  });
}

export interface DogeMetaidData {
  body?: string | Buffer;
  operation: 'init' | 'create' | 'modify' | 'revoke';
  path?: string;
  contentType?: string;
  encryption?: '0' | '1' | '2';
  version?: string;
  encoding?: BufferEncoding;
  revealAddr: string;
  flag?: 'metaid';
}

export interface InscriptionRequest {
  feeRate: number;
  metaidDataList: DogeMetaidData[];
  revealOutValue?: number;
  changeAddress?: string;
  service?: { address: string; satoshis: string };
}

const MAX_CHUNK_LEN = 240;
const DEFAULT_OUTPUT_VALUE = 1000000; // 0.01 DOGE
const DUST_LIMIT = 600;

export class DogeInscribe {
  static ECPair: ECPairAPI | null = null;
  static eccInitialized = false;

  static async ensureEccInitialized(): Promise<ECPairAPI> {
    if (!this.eccInitialized) {
      const ecc = await import('@bitcoinerlab/secp256k1');
      bitcoin.initEccLib(ecc.default);
      this.ECPair = ECPairFactory(ecc.default);
      this.eccInitialized = true;
    }
    return this.ECPair!;
  }

  static pushData(data: Buffer): Buffer {
    const len = data.length;
    if (len === 0) {
      return Buffer.from([bitcoin.opcodes.OP_0]);
    }
    if (len < 76) {
      return Buffer.concat([Buffer.from([len]), data]);
    }
    if (len <= 0xff) {
      return Buffer.concat([Buffer.from([bitcoin.opcodes.OP_PUSHDATA1, len]), data]);
    }
    if (len <= 0xffff) {
      const lenBuf = Buffer.alloc(2);
      lenBuf.writeUInt16LE(len);
      return Buffer.concat([Buffer.from([bitcoin.opcodes.OP_PUSHDATA2]), lenBuf, data]);
    }
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(len);
    return Buffer.concat([Buffer.from([bitcoin.opcodes.OP_PUSHDATA4]), lenBuf, data]);
  }

  static buildMetaIdInscriptionScript(data: DogeMetaidData): Buffer {
    const body =
      typeof data.body === 'string'
        ? Buffer.from(data.body, data.encoding || 'utf8')
        : data.body || Buffer.alloc(0);
    const bodyParts: Buffer[] = [];
    for (let i = 0; i < body.length; i += MAX_CHUNK_LEN) {
      bodyParts.push(body.slice(i, Math.min(i + MAX_CHUNK_LEN, body.length)));
    }
    if (bodyParts.length === 0) bodyParts.push(Buffer.alloc(0));

    const chunks: Buffer[] = [];
    chunks.push(this.pushData(Buffer.from('metaid')));
    chunks.push(this.pushData(Buffer.from(data.operation)));
    chunks.push(this.pushData(Buffer.from(data.contentType || 'text/plain')));
    chunks.push(this.pushData(Buffer.from(data.encryption || '0')));
    chunks.push(this.pushData(Buffer.from(data.version || '0.0.1')));
    chunks.push(this.pushData(Buffer.from(data.path || '')));
    for (const part of bodyParts) chunks.push(this.pushData(part));
    return Buffer.concat(chunks);
  }

  static buildLockScript(publicKey: Buffer, inscriptionScript: Buffer): Buffer {
    const chunks: Buffer[] = [];
    chunks.push(this.pushData(publicKey));
    chunks.push(Buffer.from([bitcoin.opcodes.OP_CHECKSIGVERIFY]));
    const dropCount = this.countScriptChunks(inscriptionScript);
    for (let i = 0; i < dropCount; i++) {
      chunks.push(Buffer.from([bitcoin.opcodes.OP_DROP]));
    }
    chunks.push(Buffer.from([bitcoin.opcodes.OP_TRUE]));
    return Buffer.concat(chunks);
  }

  static countScriptChunks(script: Buffer): number {
    let count = 0;
    let i = 0;
    while (i < script.length) {
      const opcode = script[i];
      if (opcode === 0) {
        count++;
        i++;
      } else if (opcode >= 1 && opcode <= 75) {
        count++;
        i += 1 + opcode;
      } else if (opcode === bitcoin.opcodes.OP_PUSHDATA1) {
        const len = script[i + 1];
        count++;
        i += 2 + len;
      } else if (opcode === bitcoin.opcodes.OP_PUSHDATA2) {
        const len = script[i + 1] | (script[i + 2] << 8);
        count++;
        i += 3 + len;
      } else if (opcode === bitcoin.opcodes.OP_PUSHDATA4) {
        const len =
          script[i + 1] |
          (script[i + 2] << 8) |
          (script[i + 3] << 16) |
          (script[i + 4] << 24);
        count++;
        i += 5 + len;
      } else {
        i++;
      }
    }
    return count;
  }

  static hash160(data: Buffer): Buffer {
    return bitcoin.crypto.hash160(data);
  }

  static buildP2SHOutputScript(lockScript: Buffer): Buffer {
    const lockHash = this.hash160(lockScript);
    return Buffer.concat([
      Buffer.from([bitcoin.opcodes.OP_HASH160]),
      this.pushData(lockHash),
      Buffer.from([bitcoin.opcodes.OP_EQUAL]),
    ]);
  }

  static estimateTxSize(
    p2pkhInputCount: number,
    outputCount: number,
    p2shUnlockScriptSize = 0
  ): number {
    let size = 10;
    if (p2shUnlockScriptSize > 0) {
      size += 32 + 4 + 3 + p2shUnlockScriptSize + 4;
    }
    size += p2pkhInputCount * 148;
    size += outputCount * 34;
    return size;
  }

  static selectUtxos(
    availableUtxos: DogeUTXO[],
    targetAmount: number,
    feeRate: number,
    outputCount: number,
    p2shUnlockScriptSize = 0
  ): { selectedUtxos: DogeUTXO[]; fee: number; totalInput: number } {
    const selectedUtxos: DogeUTXO[] = [];
    let totalInput = 0;
    const sortedUtxos = [...availableUtxos].sort((a, b) => b.satoshis - a.satoshis);
    for (const utxo of sortedUtxos) {
      selectedUtxos.push(utxo);
      totalInput += utxo.satoshis;
      const txSize = this.estimateTxSize(
        selectedUtxos.length,
        outputCount,
        p2shUnlockScriptSize
      );
      const fee = Math.ceil((txSize * feeRate) / 1000);
      if (totalInput >= targetAmount + fee) {
        return { selectedUtxos, fee, totalInput };
      }
    }
    throw new Error(`Insufficient funds: need ${targetAmount}, have ${totalInput}`);
  }

  static buildP2PKHOutputScript(address: string, network: bitcoin.Network): Buffer {
    const decoded = bitcoin.address.fromBase58Check(address);
    return Buffer.concat([
      Buffer.from([bitcoin.opcodes.OP_DUP, bitcoin.opcodes.OP_HASH160]),
      this.pushData(decoded.hash),
      Buffer.from([bitcoin.opcodes.OP_EQUALVERIFY, bitcoin.opcodes.OP_CHECKSIG]),
    ]);
  }

  static signP2PKHInput(
    tx: bitcoin.Transaction,
    inputIndex: number,
    keyPair: ReturnType<ECPairAPI['fromWIF']>,
    prevOutputScript: Buffer
  ): Buffer {
    const sigHash = tx.hashForSignature(
      inputIndex,
      prevOutputScript,
      bitcoin.Transaction.SIGHASH_ALL
    );
    const signature = keyPair.sign(sigHash);
    const signatureDER = bitcoin.script.signature.encode(
      signature,
      bitcoin.Transaction.SIGHASH_ALL
    );
    return Buffer.concat([
      this.pushData(signatureDER),
      this.pushData(keyPair.publicKey),
    ]);
  }

  /**
   * P2SH unlock script: <inscription_data_raw> <signature> <redeem_script>
   * inscriptionScript is NOT wrapped in pushData — its inner pushData chunks
   * must each become separate stack elements so the OP_DROPs in lockScript consume them.
   */
  static signP2SHInput(
    tx: bitcoin.Transaction,
    inputIndex: number,
    tempKeyPair: ReturnType<ECPairAPI['fromWIF']>,
    lockScript: Buffer,
    inscriptionScript: Buffer
  ): Buffer {
    const sigHash = tx.hashForSignature(inputIndex, lockScript, bitcoin.Transaction.SIGHASH_ALL);
    const signature = tempKeyPair.sign(sigHash);
    const signatureDER = bitcoin.script.signature.encode(
      signature,
      bitcoin.Transaction.SIGHASH_ALL
    );
    return Buffer.concat([
      inscriptionScript,
      this.pushData(signatureDER),
      this.pushData(lockScript),
    ]);
  }

  static async buildDogeInscriptionTxs(
    metaidData: DogeMetaidData,
    utxos: DogeUTXO[],
    walletKeyPair: ReturnType<ECPairAPI['fromWIF']>,
    feeRate: number,
    changeAddress: string,
    network: bitcoin.Network,
    revealOutValue: number,
    ECPairInstance: ECPairAPI
  ): Promise<{
    commitTx: bitcoin.Transaction;
    revealTx: bitcoin.Transaction;
    commitFee: number;
    revealFee: number;
  }> {
    const tempKeyPair = ECPairInstance.makeRandom({ network });
    const inscriptionScript = this.buildMetaIdInscriptionScript(metaidData);
    const lockScript = this.buildLockScript(tempKeyPair.publicKey, inscriptionScript);
    const p2shOutputScript = this.buildP2SHOutputScript(lockScript);
    const estimatedUnlockSize = inscriptionScript.length + 72 + lockScript.length + 10;

    const commitTx = new bitcoin.Transaction();
    commitTx.version = 2;
    commitTx.addOutput(p2shOutputScript, DEFAULT_OUTPUT_VALUE);

    const { selectedUtxos: commitUtxos, fee: commitFee, totalInput: commitTotalInput } =
      this.selectUtxos(utxos, DEFAULT_OUTPUT_VALUE, feeRate, 2, 0);

    for (const utxo of commitUtxos) {
      commitTx.addInput(Buffer.from(utxo.txId, 'hex').reverse(), utxo.outputIndex);
    }
    const commitChange = commitTotalInput - DEFAULT_OUTPUT_VALUE - commitFee;
    if (commitChange >= DUST_LIMIT) {
      commitTx.addOutput(
        this.buildP2PKHOutputScript(changeAddress, network),
        commitChange
      );
    }
    for (let i = 0; i < commitUtxos.length; i++) {
      const utxo = commitUtxos[i];
      const prevScript = this.buildP2PKHOutputScript(utxo.address, network);
      const sig = this.signP2PKHInput(commitTx, i, walletKeyPair, prevScript);
      commitTx.setInputScript(i, sig);
    }

    const revealTx = new bitcoin.Transaction();
    revealTx.version = 2;
    const commitTxId = commitTx.getId();
    revealTx.addInput(Buffer.from(commitTxId, 'hex').reverse(), 0);
    revealTx.addOutput(
      this.buildP2PKHOutputScript(metaidData.revealAddr, network),
      revealOutValue
    );

    let availableUtxos = utxos.filter(
      (u) => !commitUtxos.some((c) => c.txId === u.txId && c.outputIndex === u.outputIndex)
    );
    if (commitChange >= DUST_LIMIT) {
      availableUtxos.push({
        txId: commitTxId,
        outputIndex: commitTx.outs.length - 1,
        satoshis: commitChange,
        address: changeAddress,
      });
    }

    const { selectedUtxos: revealUtxos, fee: revealFee, totalInput: revealTotalInput } =
      this.selectUtxos(
        availableUtxos,
        revealOutValue - DEFAULT_OUTPUT_VALUE,
        feeRate,
        2,
        estimatedUnlockSize
      );
    for (const utxo of revealUtxos) {
      revealTx.addInput(Buffer.from(utxo.txId, 'hex').reverse(), utxo.outputIndex);
    }
    const revealChange =
      DEFAULT_OUTPUT_VALUE + revealTotalInput - revealOutValue - revealFee;
    if (revealChange >= DUST_LIMIT) {
      revealTx.addOutput(
        this.buildP2PKHOutputScript(changeAddress, network),
        revealChange
      );
    }
    for (let i = 0; i < revealUtxos.length; i++) {
      const utxo = revealUtxos[i];
      const prevScript = this.buildP2PKHOutputScript(utxo.address, network);
      const sig = this.signP2PKHInput(revealTx, i + 1, walletKeyPair, prevScript);
      revealTx.setInputScript(i + 1, sig);
    }
    const unlockScript = this.signP2SHInput(
      revealTx,
      0,
      tempKeyPair,
      lockScript,
      inscriptionScript
    );
    revealTx.setInputScript(0, unlockScript);

    return { commitTx, revealTx, commitFee, revealFee };
  }

  static async process({
    mnemonic,
    pathStr,
    data: { metaidDataList, service, feeRate, revealOutValue },
    options = { noBroadcast: false },
  }: {
    mnemonic: string;
    pathStr: string;
    data: InscriptionRequest;
    options?: { noBroadcast?: boolean };
  }): Promise<{
    success: boolean;
    txids?: string[];
    pinId?: string;
    totalCost?: number;
    error?: string;
  }> {
    if (!mnemonic) {
      return { success: false, error: 'mnemonic is null' };
    }
    const ECPairInstance = await this.ensureEccInitialized();
    const wallet = await getDogeWalletForWorker(mnemonic, pathStr);
    const address = wallet.getAddress();
    const privateKeyWIF = wallet.getPrivateKey();
    const network = wallet.getNetwork() as unknown as bitcoin.Network;

    const walletKeyPair = ECPairInstance.fromWIF(privateKeyWIF, network);

    const rawUtxos = await fetchDogeUtxos(address, true);
    const utxos: DogeUTXO[] = rawUtxos.map((u) => ({
      txId: u.txId,
      outputIndex: u.outputIndex,
      satoshis: u.satoshis,
      address: u.address || address,
      rawTx: u.rawTx,
      height: u.height,
      confirmed: u.confirmed,
    }));

    if (utxos.length === 0) {
      return { success: false, error: 'No UTXOs available' };
    }

    debugLog(`address=${address} utxoCount=${utxos.length} feeRate=${feeRate} (sat/KB)`);
    const totalUtxo = utxos.reduce((s, u) => s + u.satoshis, 0);
    debugLog(`totalUtxoSatoshis=${totalUtxo}`);

    let totalCommitCost = 0;
    let totalRevealCost = 0;
    const commitTxs: bitcoin.Transaction[] = [];
    const revealTxs: bitcoin.Transaction[] = [];
    let availableUtxos = [...utxos];

    for (const metaidData of metaidDataList) {
      const { commitTx, revealTx, commitFee, revealFee } =
        await this.buildDogeInscriptionTxs(
          metaidData,
          availableUtxos,
          walletKeyPair,
          feeRate,
          address,
          network,
          revealOutValue || DEFAULT_OUTPUT_VALUE,
          ECPairInstance
        );
      const commitSize = commitTx.toHex().length / 2;
      const revealSize = revealTx.toHex().length / 2;
      debugLog(`pin#${commitTxs.length} commitTxSize=${commitSize} commitFee=${commitFee} revealTxSize=${revealSize} revealFee=${revealFee}`);

      commitTxs.push(commitTx);
      revealTxs.push(revealTx);
      totalCommitCost += commitFee;
      totalRevealCost += revealFee;
    }

    const totalCost =
      totalCommitCost +
      totalRevealCost +
      (service ? parseInt(service.satoshis, 10) : 0);
    debugLog(`totalCommitCost=${totalCommitCost} totalRevealCost=${totalRevealCost} totalCost=${totalCost}`);

    if (!options.noBroadcast) {
      const revealTxIds: string[] = [];
      for (let i = 0; i < commitTxs.length; i++) {
        const commitHex = commitTxs[i].toHex();
        const localCommitTxId = commitTxs[i].getId();
        debugLog(`broadcast commit tx#${i} size=${commitHex.length / 2} localTxId=${localCommitTxId}`);
        let broadcastCommitTxId: string;
        try {
          broadcastCommitTxId = await broadcastDogeTx(commitHex);
          debugLog(`broadcast commit tx#${i} ok remoteTxId=${broadcastCommitTxId}`);
        } catch (e) {
          debugLog(`broadcast commit tx#${i} FAIL: ${e instanceof Error ? e.message : String(e)}`);
          throw e;
        }
        const revealHex = revealTxs[i].toHex();
        const localRevealTxId = revealTxs[i].getId();
        debugLog(`broadcast reveal tx#${i} size=${revealHex.length / 2} localTxId=${localRevealTxId}`);
        debugLog(`reveal tx#${i} hex=${revealHex}`);
        try {
          const revealTxId = await broadcastDogeTx(revealHex);
          revealTxIds.push(revealTxId);
          debugLog(`broadcast reveal tx#${i} ok remoteTxId=${revealTxId}`);
        } catch (e) {
          debugLog(`broadcast reveal tx#${i} FAIL: ${e instanceof Error ? e.message : String(e)}`);
          throw e;
        }
      }
      const pinId = revealTxIds[0] ? `${revealTxIds[0]}i0` : undefined;
      return {
        success: true,
        txids: revealTxIds,
        pinId,
        totalCost,
      };
    }

    return {
      success: true,
      txids: revealTxs.map((t) => t.getId()),
      totalCost,
    };
  }
}

export async function runDogeCreatePin(
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
  const wallet = await getDogeWalletForWorker(mnemonic, pathStr);
  const address = wallet.getAddress();

  const dogeMetaidData: DogeMetaidData = {
    operation: metaidData.operation as DogeMetaidData['operation'],
    path: metaidData.path,
    contentType: metaidData.contentType || 'text/plain',
    encryption: (metaidData.encryption as DogeMetaidData['encryption']) || '0',
    version: metaidData.version || '0.0.1',
    body,
    revealAddr: address,
  };

  const result = await DogeInscribe.process({
    mnemonic,
    pathStr,
    data: {
      feeRate,
      metaidDataList: [dogeMetaidData],
      revealOutValue: DEFAULT_OUTPUT_VALUE,
    },
    options: { noBroadcast: false },
  });

  if (!result.success) {
    throw new Error(result.error || 'Doge createPin failed');
  }
  const txids = result.txids ?? [];
  const pinId = result.pinId ?? (txids[0] ? `${txids[0]}i0` : '');
  const totalCost = result.totalCost ?? 0;
  return { success: true, txids, pinId, totalCost };
}
