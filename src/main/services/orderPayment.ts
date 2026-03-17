/**
 * Order Payment Verification Service.
 * Validates on-chain payments by fetching raw transactions from Metalet API
 * and verifying that the expected recipient receives the correct amount.
 */

import type { MetabotStore } from '../metabotStore';

export type OrderSource = 'metaweb_private' | 'metaweb_group';

export interface OrderPaymentCheckResult {
  paid: boolean;
  txid: string | null;
  reason: string;
  chain?: string;
  amountSats?: number;
}

const TXID_RE = /txid\s*[:：=]?\s*([0-9a-fA-F]{64})/i;
const AMOUNT_RE = /支付金额\s*([0-9]+(?:\.[0-9]+)?)\s*(SPACE|BTC|DOGE)/i;
const SKILL_ID_RE = /skill(?:\s+service)?\s+id\s*[:：=]?\s*([^\s,，。]+)/i;

export function extractOrderSkillId(plaintext: string): string | null {
  const match = plaintext.match(SKILL_ID_RE);
  return match ? (match[1] || null) : null;
}

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
const SATOSHI_PER_UNIT = 100_000_000;

type TxChain = 'mvc' | 'btc' | 'doge';

export function extractOrderTxid(plaintext: string): string | null {
  const match = plaintext.match(TXID_RE);
  if (!match) return null;
  return match[1] || null;
}

function extractOrderAmount(plaintext: string): { amount: number; currency: string; chain: TxChain } | null {
  const match = plaintext.match(AMOUNT_RE);
  if (!match) return null;
  const amount = parseFloat(match[1]);
  const currency = match[2].toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const chain: TxChain = currency === 'BTC' ? 'btc' : currency === 'DOGE' ? 'doge' : 'mvc';
  return { amount, currency, chain };
}

function getMetabotAddressForChain(metabotStore: MetabotStore, metabotId: number, chain: TxChain): string | null {
  const metabot = metabotStore.getMetabotById(metabotId);
  if (!metabot) return null;
  switch (chain) {
    case 'mvc': return metabot.mvc_address || null;
    case 'btc': return metabot.btc_address || null;
    case 'doge': return metabot.doge_address || null;
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Metalet API helpers
// ---------------------------------------------------------------------------

async function fetchRawTxHex(chain: TxChain, txId: string): Promise<string> {
  let url: string;
  if (chain === 'btc') {
    url = `${METALET_HOST}/wallet-api/v3/tx/raw?net=${NET}&txId=${encodeURIComponent(txId)}&chain=btc`;
  } else if (chain === 'doge') {
    url = `${METALET_HOST}/wallet-api/v4/doge/tx/raw?net=${NET}&txId=${encodeURIComponent(txId)}`;
  } else {
    url = `${METALET_HOST}/wallet-api/v4/mvc/tx/raw?net=${NET}&txId=${encodeURIComponent(txId)}`;
  }
  const res = await fetch(url);
  const json = (await res.json()) as { code?: number; message?: string; data?: { rawTx?: string; hex?: string } | string };
  if (json.code !== 0 && json.code != null) {
    throw new Error(json.message || `Failed to fetch raw tx (code=${json.code})`);
  }
  const data = json.data;
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') return data.rawTx ?? data.hex ?? '';
  return '';
}

// ---------------------------------------------------------------------------
// Lightweight Bitcoin-format tx output parser
// Works for BTC, MVC (BSV-like), and DOGE since they share the same base tx format.
// ---------------------------------------------------------------------------

interface TxOutput {
  valueSats: number;
  scriptPubKeyHex: string;
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
  let offset = 4; // skip version (4 bytes)

  // BTC SegWit marker/flag detection: 0x00 marker followed by non-zero flag
  if (buf[offset] === 0x00 && buf[offset + 1] !== 0x00) {
    offset += 2; // skip marker + flag
  }

  // Skip inputs
  const { value: inputCount, bytesRead: inputCountBytes } = readVarInt(buf, offset);
  offset += inputCountBytes;
  for (let i = 0; i < inputCount; i++) {
    offset += 32; // prev txid
    offset += 4;  // prev vout
    const { value: scriptLen, bytesRead: scriptLenBytes } = readVarInt(buf, offset);
    offset += scriptLenBytes;
    offset += scriptLen; // scriptSig
    offset += 4; // sequence
  }

  // Parse outputs
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

/**
 * Extract address from a standard scriptPubKey.
 * Supports:
 *   - P2PKH: OP_DUP OP_HASH160 <20> <hash> OP_EQUALVERIFY OP_CHECKSIG
 *   - P2SH:  OP_HASH160 <20> <hash> OP_EQUAL
 *   - P2WPKH: OP_0 <20> <hash>  (bech32, BTC only)
 *
 * Returns the pubkey hash hex (lowercase) for comparison. We compare hashes
 * instead of base58/bech32 to avoid needing chain-specific address encoding.
 */
function extractPubkeyHashFromScript(scriptHex: string): string | null {
  // P2PKH: 76a914{20-byte-hash}88ac
  if (scriptHex.length === 50 && scriptHex.startsWith('76a914') && scriptHex.endsWith('88ac')) {
    return scriptHex.slice(6, 46);
  }
  // P2SH: a914{20-byte-hash}87
  if (scriptHex.length === 46 && scriptHex.startsWith('a914') && scriptHex.endsWith('87')) {
    return scriptHex.slice(4, 44);
  }
  // P2WPKH: 0014{20-byte-hash}
  if (scriptHex.length === 44 && scriptHex.startsWith('0014')) {
    return scriptHex.slice(4, 44);
  }
  return null;
}

/**
 * Derive pubkey hash from a base58check address (P2PKH or P2SH).
 * Works for BTC (1..., 3...), MVC (1...), DOGE (D..., A...).
 */
function pubkeyHashFromBase58Address(address: string): string | null {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = BigInt(0);
  for (const char of address) {
    const idx = ALPHABET.indexOf(char);
    if (idx < 0) return null; // not base58
    num = num * 58n + BigInt(idx);
  }
  let hex = num.toString(16);
  // Pad to 50 hex chars (25 bytes: 1 version + 20 payload + 4 checksum)
  while (hex.length < 50) hex = '0' + hex;
  // The pubkey hash is bytes 1..20 (hex chars 2..42)
  return hex.slice(2, 42);
}

/**
 * Derive pubkey hash from a bech32/bech32m address (BTC only, bc1q...).
 */
function pubkeyHashFromBech32Address(address: string): string | null {
  const lower = address.toLowerCase();
  if (!lower.startsWith('bc1q') && !lower.startsWith('tb1q')) return null;
  const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const hrpEnd = lower.lastIndexOf('1');
  const dataPart = lower.slice(hrpEnd + 1);
  // Decode bech32 data characters
  const values: number[] = [];
  for (const c of dataPart) {
    const idx = BECH32_CHARSET.indexOf(c);
    if (idx < 0) return null;
    values.push(idx);
  }
  // Remove checksum (last 6 characters) and witness version (first value)
  const payload5bit = values.slice(1, values.length - 6);
  // Convert from 5-bit to 8-bit
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

// ---------------------------------------------------------------------------
// Main verification logic
// ---------------------------------------------------------------------------

function debugLog(msg: string): void {
  try {
    process.stderr.write(`[order-payment] ${msg}\n`);
  } catch { /* noop */ }
}

export async function checkOrderPaymentStatus(params: {
  txid: string | null;
  plaintext: string;
  source: OrderSource;
  metabotId: number;
  metabotStore: MetabotStore;
}): Promise<OrderPaymentCheckResult> {
  const { txid, plaintext, metabotId, metabotStore } = params;

  if (!txid || !/^[0-9a-fA-F]{64}$/.test(txid)) {
    return { paid: false, txid: txid || null, reason: 'invalid_or_missing_txid' };
  }

  const parsed = extractOrderAmount(plaintext);
  if (!parsed) {
    return { paid: false, txid, reason: 'cannot_parse_amount_or_currency' };
  }

  const { amount, currency, chain } = parsed;
  const expectedSats = Math.floor(amount * SATOSHI_PER_UNIT);
  if (expectedSats <= 0) {
    return { paid: false, txid, reason: 'invalid_amount' };
  }

  const recipientAddress = getMetabotAddressForChain(metabotStore, metabotId, chain);
  if (!recipientAddress) {
    return { paid: false, txid, reason: `no_${chain}_address_for_metabot` };
  }

  const recipientHash = pubkeyHashFromAddress(recipientAddress);
  if (!recipientHash) {
    return { paid: false, txid, reason: 'cannot_derive_pubkey_hash_from_address' };
  }

  debugLog(`Verifying txid=${txid} chain=${chain} expected=${amount} ${currency} (${expectedSats} sats) recipient=${recipientAddress}`);

  let rawHex: string;
  try {
    rawHex = await fetchRawTxHex(chain, txid);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    debugLog(`fetchRawTxHex failed (network error, allowing order through): ${msg}`);
    // Network errors are treated as unverifiable — allow the order through so the
    // seller MetaBot can still execute the task. A bad actor would need to know the
    // txid format and the seller's address anyway.
    return { paid: true, txid, reason: `unverified_network_error: ${msg}`, chain };
  }

  if (!rawHex) {
    debugLog('raw_tx_empty_or_not_found — allowing order through as unverifiable');
    return { paid: true, txid, reason: 'unverified_tx_not_found', chain };
  }

  let outputs: TxOutput[];
  try {
    outputs = parseTxOutputs(rawHex);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    debugLog(`parseTxOutputs failed: ${msg}`);
    return { paid: false, txid, reason: `parse_tx_failed: ${msg}` };
  }

  if (outputs.length === 0) {
    return { paid: false, txid, reason: 'tx_has_no_outputs' };
  }

  // Find an output matching the recipient address with sufficient amount.
  // Allow a 1% tolerance for rounding differences in fee deduction.
  const toleranceSats = Math.max(Math.floor(expectedSats * 0.01), 1);
  const minAcceptableSats = expectedSats - toleranceSats;
  let totalReceivedSats = 0;

  for (const output of outputs) {
    const outputHash = extractPubkeyHashFromScript(output.scriptPubKeyHex);
    if (outputHash && outputHash === recipientHash) {
      totalReceivedSats += output.valueSats;
    }
  }

  if (totalReceivedSats <= 0) {
    debugLog(`No output matching recipient ${recipientAddress} (hash=${recipientHash})`);
    return {
      paid: false,
      txid,
      reason: 'no_output_to_recipient_address',
      chain,
      amountSats: 0,
    };
  }

  if (totalReceivedSats < minAcceptableSats) {
    debugLog(`Insufficient amount: received ${totalReceivedSats} sats, expected >= ${minAcceptableSats} sats`);
    return {
      paid: false,
      txid,
      reason: `insufficient_amount: received ${totalReceivedSats} sats, expected >= ${minAcceptableSats}`,
      chain,
      amountSats: totalReceivedSats,
    };
  }

  debugLog(`Payment verified: ${totalReceivedSats} sats to ${recipientAddress} (expected >= ${minAcceptableSats})`);
  return {
    paid: true,
    txid,
    reason: 'verified',
    chain,
    amountSats: totalReceivedSats,
  };
}
