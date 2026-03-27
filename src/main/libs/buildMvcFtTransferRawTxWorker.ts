import { API_NET, API_TARGET, FtManager, mvc } from 'meta-contract';
import { getMvcWallet, parseAddressIndexFromPath } from '../services/metabotWalletService';

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";

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

function resolveTokenGenesis(token: { tokenID?: string; genesisHash?: string }): string {
  return String(token?.tokenID || token?.genesisHash || '').trim();
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
      wif: senderWif,
      address: mvcWallet.getAddress(),
    }];
  } else {
    const allUtxos = await ftManager.api.getUnspents(mvcWallet.getAddress());
    utxos = allUtxos.filter((utxo: any) => {
      const key = `${String(utxo.txId || '').toLowerCase()}:${Number(utxo.outputIndex)}`;
      return !excludeOutpoints.has(key);
    });
  }
  if (utxos.length === 0) {
    console.log(JSON.stringify({ success: false, error: 'No spendable MVC UTXOs after exclusions' }));
    process.exit(1);
  }

  const transferResult = await ftManager.transfer({
    codehash: token.codeHash,
    genesis: tokenGenesis,
    receivers: [{ address: toAddress, amount }],
    senderWif,
    utxos,
    noBroadcast: true,
  });

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
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ success: false, error: getMessage(err) }));
  process.exit(1);
});
