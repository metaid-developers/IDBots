const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';

export type TransferChain = 'mvc' | 'btc' | 'doge';

export interface VerifyTransferInput {
  chain: TransferChain;
  txid: string;
  recipientAddress: string;
  expectedAmountSats: number;
  toleranceSats?: number;
  fetchRawTxHex?: (chain: TransferChain, txid: string) => Promise<string>;
}

export interface VerifyTransferResult {
  valid: boolean;
  reason: string;
  matchedAmountSats?: number;
}

interface TxOutput {
  valueSats: number;
  scriptPubKeyHex: string;
}

export async function fetchRawTxHexFromMetalet(
  chain: TransferChain,
  txId: string
): Promise<string> {
  let url: string;
  if (chain === 'btc') {
    url = `${METALET_HOST}/wallet-api/v3/tx/raw?net=${NET}&txId=${encodeURIComponent(txId)}&chain=btc`;
  } else if (chain === 'doge') {
    url = `${METALET_HOST}/wallet-api/v4/doge/tx/raw?net=${NET}&txId=${encodeURIComponent(txId)}`;
  } else {
    url = `${METALET_HOST}/wallet-api/v4/mvc/tx/raw?net=${NET}&txId=${encodeURIComponent(txId)}`;
  }
  const res = await fetch(url);
  const json = (await res.json()) as {
    code?: number;
    message?: string;
    data?: { rawTx?: string; hex?: string } | string;
  };
  if (json.code !== 0 && json.code != null) {
    throw new Error(json.message || `Failed to fetch raw tx (code=${json.code})`);
  }
  const data = json.data;
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') return data.rawTx ?? data.hex ?? '';
  return '';
}

function readVarInt(buf: Buffer, offset: number): { value: number; bytesRead: number } {
  const first = buf[offset];
  if (first < 0xfd) return { value: first, bytesRead: 1 };
  if (first === 0xfd) return { value: buf.readUInt16LE(offset + 1), bytesRead: 3 };
  if (first === 0xfe) return { value: buf.readUInt32LE(offset + 1), bytesRead: 5 };
  const lo = buf.readUInt32LE(offset + 1);
  const hi = buf.readUInt32LE(offset + 5);
  return { value: hi * 0x100000000 + lo, bytesRead: 9 };
}

function parseTxOutputs(rawHex: string): TxOutput[] {
  const buf = Buffer.from(rawHex, 'hex');
  let offset = 4;

  if (buf[offset] === 0x00 && buf[offset + 1] !== 0x00) {
    offset += 2;
  }

  const { value: inputCount, bytesRead: inputCountBytes } = readVarInt(buf, offset);
  offset += inputCountBytes;
  for (let i = 0; i < inputCount; i++) {
    offset += 32;
    offset += 4;
    const { value: scriptLen, bytesRead: scriptLenBytes } = readVarInt(buf, offset);
    offset += scriptLenBytes;
    offset += scriptLen;
    offset += 4;
  }

  const { value: outputCount, bytesRead: outputCountBytes } = readVarInt(buf, offset);
  offset += outputCountBytes;
  const outputs: TxOutput[] = [];
  for (let i = 0; i < outputCount; i++) {
    const valueSats = Number(buf.readBigUInt64LE(offset));
    offset += 8;
    const { value: scriptLen, bytesRead: scriptLenBytes } = readVarInt(buf, offset);
    offset += scriptLenBytes;
    const scriptPubKeyHex = buf.subarray(offset, offset + scriptLen).toString('hex');
    offset += scriptLen;
    outputs.push({ valueSats, scriptPubKeyHex });
  }
  return outputs;
}

function extractPubkeyHashFromScript(scriptHex: string): string | null {
  if (scriptHex.length === 50 && scriptHex.startsWith('76a914') && scriptHex.endsWith('88ac')) {
    return scriptHex.slice(6, 46);
  }
  if (scriptHex.length === 46 && scriptHex.startsWith('a914') && scriptHex.endsWith('87')) {
    return scriptHex.slice(4, 44);
  }
  if (scriptHex.length === 44 && scriptHex.startsWith('0014')) {
    return scriptHex.slice(4, 44);
  }
  return null;
}

function pubkeyHashFromBase58Address(address: string): string | null {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = BigInt(0);
  for (const char of address) {
    const idx = ALPHABET.indexOf(char);
    if (idx < 0) return null;
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  while (hex.length < 50) hex = `0${hex}`;
  return hex.slice(2, 42);
}

function pubkeyHashFromBech32Address(address: string): string | null {
  const lower = address.toLowerCase();
  if (!lower.startsWith('bc1q') && !lower.startsWith('tb1q')) return null;
  const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const hrpEnd = lower.lastIndexOf('1');
  const dataPart = lower.slice(hrpEnd + 1);
  const values: number[] = [];
  for (const c of dataPart) {
    const idx = BECH32_CHARSET.indexOf(c);
    if (idx < 0) return null;
    values.push(idx);
  }
  const payload5bit = values.slice(1, values.length - 6);
  let acc = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const val of payload5bit) {
    acc = (acc << 5) | val;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  if (bytes.length !== 20) return null;
  return Buffer.from(bytes).toString('hex');
}

function pubkeyHashFromAddress(address: string): string | null {
  if (!address) return null;
  if (address.startsWith('bc1') || address.startsWith('tb1')) {
    return pubkeyHashFromBech32Address(address);
  }
  return pubkeyHashFromBase58Address(address);
}

export async function verifyTransferToRecipient(
  input: VerifyTransferInput
): Promise<VerifyTransferResult> {
  if (!/^[0-9a-fA-F]{64}$/.test(input.txid)) {
    return { valid: false, reason: 'invalid_txid' };
  }
  if (!Number.isFinite(input.expectedAmountSats) || input.expectedAmountSats <= 0) {
    return { valid: false, reason: 'invalid_expected_amount' };
  }

  const recipientHash = pubkeyHashFromAddress(input.recipientAddress);
  if (!recipientHash) {
    return { valid: false, reason: 'invalid_recipient_address' };
  }

  let rawHex = '';
  try {
    rawHex = await (input.fetchRawTxHex ?? fetchRawTxHexFromMetalet)(input.chain, input.txid);
  } catch (error) {
    return {
      valid: false,
      reason: `fetch_raw_tx_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!rawHex) {
    return { valid: false, reason: 'raw_tx_not_found' };
  }

  let outputs: TxOutput[];
  try {
    outputs = parseTxOutputs(rawHex);
  } catch (error) {
    return {
      valid: false,
      reason: `parse_tx_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let totalMatchedSats = 0;
  for (const output of outputs) {
    const outputHash = extractPubkeyHashFromScript(output.scriptPubKeyHex);
    if (outputHash === recipientHash) {
      totalMatchedSats += output.valueSats;
    }
  }

  const toleranceSats = Math.max(0, input.toleranceSats ?? 0);
  const minAcceptableSats = input.expectedAmountSats - toleranceSats;
  if (totalMatchedSats < minAcceptableSats) {
    return {
      valid: false,
      reason: `recipient_amount_mismatch:${totalMatchedSats}:${minAcceptableSats}`,
      matchedAmountSats: totalMatchedSats,
    };
  }

  return {
    valid: true,
    reason: 'verified',
    matchedAmountSats: totalMatchedSats,
  };
}
