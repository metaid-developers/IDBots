import { API_NET, API_TARGET, Wallet, mvc } from 'meta-contract';
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
    toAddress: string;
    amountSats: number;
    feeRate: number;
    excludeOutpoints?: string[];
  };
  const { toAddress, amountSats, feeRate } = payload;
  if (!toAddress || !Number.isInteger(amountSats) || amountSats <= 0 || !Number.isFinite(feeRate) || feeRate <= 0) {
    console.log(JSON.stringify({ success: false, error: 'Invalid payload: toAddress, amountSats (>0), feeRate (>0) required' }));
    process.exit(1);
  }

  const addressIndex = parseAddressIndexFromPath(pathStr);
  const mvcWallet = await getMvcWallet(mnemonic, addressIndex);
  const senderWif = mvcWallet.getPrivateKey();
  const wallet = new Wallet(senderWif, API_NET.MAIN, feeRate, API_TARGET.APIMVC);
  const excludeOutpoints = normalizeExcludeOutpoints(payload.excludeOutpoints);

  const allUtxos = await wallet.api.getUnspents(mvcWallet.getAddress());
  const utxos = allUtxos.filter((utxo) => {
    const key = `${String((utxo as any).txId || '').toLowerCase()}:${Number((utxo as any).outputIndex)}`;
    return !excludeOutpoints.has(key);
  });
  if (utxos.length === 0) {
    console.log(JSON.stringify({ success: false, error: 'No spendable MVC UTXOs after exclusions' }));
    process.exit(1);
  }

  const receivers = [{ address: toAddress, amount: amountSats }];
  const result = await wallet.sendArray(receivers, utxos, { noBroadcast: true });
  const tx = new mvc.Transaction(result.txHex);
  const spentOutpoints = tx.inputs.map((input: any) => `${input.prevTxId.toString('hex')}:${Number(input.outputIndex)}`);

  console.log(
    JSON.stringify({
      success: true,
      txHex: result.txHex,
      txid: result.txId,
      spentOutpoints,
      changeOutpoint: tx.outputs.length > receivers.length ? `${tx.id}:${tx.outputs.length - 1}` : null,
    }),
  );
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ success: false, error: getMessage(err) }));
  process.exit(1);
});
