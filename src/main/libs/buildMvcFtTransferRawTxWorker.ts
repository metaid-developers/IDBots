import { API_NET, API_TARGET, FtManager, mvc } from 'meta-contract';
import { getMvcWallet, parseAddressIndexFromPath } from '../services/metabotWalletService';
import {
  attachMvcFundingSignatureContext,
  selectMvcFundingUtxos,
} from '../services/tokenTransferAdapters';

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";
const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';

function logStep(message: string, details?: Record<string, unknown>): void {
  try {
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    process.stderr.write(`[buildMvcFtTransferRawTxWorker] ${message}${suffix}\n`);
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

function isInsufficientMvcFundingError(err: unknown): boolean {
  const normalized = getMessage(err).toLowerCase();
  return normalized.includes('insufficient balance') || normalized.includes('not enough balance') || normalized.includes('余额不足');
}

function normalizeExcludeOutpoints(input: unknown): Set<string> {
  if (!Array.isArray(input)) return new Set();
  return new Set(
    input
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((value) => /^[0-9a-f]{64}:\d+$/.test(value)),
  );
}

function resolveTokenGenesis(token: { tokenID?: string; genesisHash?: string }): string {
  return String(token?.tokenID || token?.genesisHash || '').trim();
}

async function fetchMvcFundingUtxos(address: string): Promise<Array<{ txid: string; outIndex: number; value: number; height: number }>> {
  const all: Array<{ txid: string; outIndex: number; value: number; height: number }> = [];
  let flag: string | undefined;
  while (true) {
    const params = new URLSearchParams({ address, net: NET, ...(flag ? { flag } : {}) });
    const res = await fetch(`${METALET_HOST}/wallet-api/v4/mvc/address/utxo-list?${params}`);
    const json = (await res.json()) as { data?: { list?: Array<{ txid: string; outIndex: number; value: number; height: number; flag?: string }> } };
    const list = json?.data?.list ?? [];
    if (!list.length) break;
    all.push(...list.filter((u) => u.value >= 600));
    flag = list[list.length - 1]?.flag;
    if (!flag) break;
  }
  return all;
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
    token: {
      genesisHash: string;
      codeHash: string;
      decimal?: number;
    };
    toAddress: string;
    amount: string;
    feeRate: number;
    excludeOutpoints?: string[];
    fundingRawTx?: string;
    fundingOutpoint?: string;
  };

  const token = payload.token ?? ({} as any);
  const toAddress = String(payload.toAddress || '').trim();
  const amount = String(payload.amount || '').trim();
  const feeRate = Number(payload.feeRate);
  const tokenGenesis = resolveTokenGenesis(token);
  if (!toAddress || !/^\d+$/.test(amount) || !tokenGenesis || !token.codeHash || !Number.isFinite(feeRate) || feeRate <= 0) {
    console.log(JSON.stringify({ success: false, error: 'Invalid payload for MVC FT transfer raw tx worker' }));
    process.exit(1);
  }

  const addressIndex = parseAddressIndexFromPath(pathStr);
  const mvcWallet = await getMvcWallet(mnemonic, addressIndex);
  const senderWif = mvcWallet.getPrivateKey();
  const senderAddress = mvcWallet.getAddress();
  const ftManager = new FtManager({
    network: API_NET.MAIN,
    apiTarget: API_TARGET.APIMVC,
    purse: senderWif,
    feeb: feeRate,
  });

  const excludeOutpoints = normalizeExcludeOutpoints(payload.excludeOutpoints);
  const fundingRawTx = String(payload.fundingRawTx || '').trim();
  const fundingOutpoint = String(payload.fundingOutpoint || '').trim().toLowerCase();
  let utxos;
  if (fundingRawTx || fundingOutpoint) {
    if (!fundingRawTx || !/^[0-9a-f]{64}:\d+$/.test(fundingOutpoint)) {
      console.log(JSON.stringify({ success: false, error: 'fundingRawTx and valid fundingOutpoint are required together' }));
      process.exit(1);
    }
    const [fundingTxid, fundingVoutRaw] = fundingOutpoint.split(':');
    const fundingVout = Number(fundingVoutRaw);
    const fundingTx = new mvc.Transaction(fundingRawTx);
    if (fundingTx.id !== fundingTxid || !Number.isInteger(fundingVout) || fundingVout < 0 || fundingVout >= fundingTx.outputs.length) {
      console.log(JSON.stringify({ success: false, error: 'fundingOutpoint does not match fundingRawTx' }));
      process.exit(1);
    }
    const output: any = fundingTx.outputs[fundingVout];
    try {
      const address = output.script.toAddress('livenet').toString();
      if (address !== mvcWallet.getAddress()) {
        console.log(JSON.stringify({ success: false, error: 'fundingOutpoint must pay back to the signing wallet address' }));
        process.exit(1);
      }
    } catch {
      console.log(JSON.stringify({ success: false, error: 'fundingOutpoint must be a standard address output' }));
      process.exit(1);
    }
    utxos = [{
      txId: fundingTxid,
      outputIndex: fundingVout,
      satoshis: Number(output.satoshis),
      address: senderAddress,
    }];
    logStep('Using explicit MVC FT funding outpoint', {
      fundingOutpoint,
    });
  } else {
    const allUtxos = await fetchMvcFundingUtxos(senderAddress);
    utxos = allUtxos
      .map((utxo) => ({
        txId: String(utxo.txid || '').trim(),
        outputIndex: Number(utxo.outIndex),
        satoshis: Number(utxo.value),
        height: Number(utxo.height),
        address: senderAddress,
      }))
      .filter((utxo) => {
        const key = `${utxo.txId.toLowerCase()}:${utxo.outputIndex}`;
        return /^[0-9a-f]{64}$/i.test(utxo.txId) && Number.isInteger(utxo.outputIndex) && utxo.outputIndex >= 0 && utxo.satoshis > 600 && !excludeOutpoints.has(key);
      });
    logStep('Fetched MVC FT funding candidates', {
      candidateOutpoints: utxos.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
      excludedOutpoints: Array.from(excludeOutpoints),
    });
  }
  utxos = attachMvcFundingSignatureContext(utxos, {
    senderWif,
    senderAddress,
  });
  utxos = selectMvcFundingUtxos(utxos);
  logStep('Picked MVC FT funding inputs', {
    pickedOutpoints: utxos.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
  });
  if (utxos.length === 0) {
    console.log(JSON.stringify({ success: false, error: 'No spendable MVC UTXOs after exclusions' }));
    process.exit(1);
  }

  let transferResult: Awaited<ReturnType<typeof ftManager.transfer>> | null = null;
  let lastTransferError: unknown = null;
  let pickedFundingUtxos = utxos;
  for (let prefixSize = 1; prefixSize <= utxos.length; prefixSize += 1) {
    const fundingSlice = utxos.slice(0, prefixSize);
    try {
      transferResult = await ftManager.transfer({
        codehash: token.codeHash,
        genesis: tokenGenesis,
        receivers: [{ address: toAddress, amount }],
        senderWif,
        utxos: fundingSlice,
        noBroadcast: true,
      });
      pickedFundingUtxos = fundingSlice;
      logStep('Built MVC FT bundle with funding prefix', {
        prefixSize,
        pickedOutpoints: fundingSlice.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
      });
      break;
    } catch (error) {
      lastTransferError = error;
      if (prefixSize < utxos.length && isInsufficientMvcFundingError(error)) {
        continue;
      }
      throw error;
    }
  }

  if (!transferResult) {
    throw lastTransferError instanceof Error ? lastTransferError : new Error(getMessage(lastTransferError || 'Failed to build MVC FT transfer'));
  }

  const spentOutpoints = transferResult.tx.inputs.map(
    (input: any) => `${input.prevTxId.toString('hex')}:${Number(input.outputIndex)}`,
  );

  console.log(
    JSON.stringify({
      success: true,
      txHex: transferResult.txHex,
      amountCheckRawTx: transferResult.routeCheckTxHex,
      outputIndex: 0,
      spentOutpoints,
      changeOutpoint: transferResult.tx.outputs.length > 1 ? `${transferResult.txid}:${transferResult.tx.outputs.length - 1}` : null,
    }),
  );
  logStep('Built MVC FT raw-tx bundle locally', {
    txid: transferResult.txid,
    spentOutpoints,
    fundingOutpoints: pickedFundingUtxos.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`),
  });
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(JSON.stringify({ success: false, error: getMessage(err) }));
    process.exit(1);
  });
}
