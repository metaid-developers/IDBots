import { createHash } from 'crypto';
import { computeMvcTxidFromRawTx } from '../libs/mvcSpend';
import {
  getMvcCachedFundingOutpointKey,
  type MvcCachedFundingUtxo,
} from './mvcSpendSessionState';

export interface RecentMvcPinTransaction {
  txid: string;
  timestamp: number;
}

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
const MIN_MVC_FUNDING_SATOSHIS = 600;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function sha256(data: Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

function decodeBase58Check(input: string): Buffer {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    throw new Error('address is required');
  }

  let value = 0n;
  for (const char of trimmed) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error('invalid base58 character');
    }
    value = value * 58n + BigInt(index);
  }

  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }
  for (const char of trimmed) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  const decoded = Buffer.from(bytes);
  if (decoded.length < 5) {
    throw new Error('invalid base58check payload');
  }
  const payload = decoded.subarray(0, -4);
  const checksum = decoded.subarray(-4);
  const expectedChecksum = sha256(sha256(payload)).subarray(0, 4);
  if (!checksum.equals(expectedChecksum)) {
    throw new Error('invalid base58check checksum');
  }
  return payload;
}

function getP2pkhHashHexFromAddress(address: string): string | null {
  try {
    const payload = decodeBase58Check(address);
    if (payload.length !== 21) return null;
    return payload.subarray(1).toString('hex');
  } catch {
    return null;
  }
}

function readVarInt(buffer: Buffer, offset: number): { value: number; nextOffset: number } {
  const prefix = buffer.readUInt8(offset);
  if (prefix < 0xfd) {
    return { value: prefix, nextOffset: offset + 1 };
  }
  if (prefix === 0xfd) {
    return { value: buffer.readUInt16LE(offset + 1), nextOffset: offset + 3 };
  }
  if (prefix === 0xfe) {
    return { value: buffer.readUInt32LE(offset + 1), nextOffset: offset + 5 };
  }
  const value = Number(buffer.readBigUInt64LE(offset + 1));
  return { value, nextOffset: offset + 9 };
}

function readUInt64LENumber(buffer: Buffer, offset: number): number {
  return Number(buffer.readBigUInt64LE(offset));
}

function extractTxOutputs(rawTxHex: string): Array<{ outputIndex: number; satoshis: number; scriptHex: string }> {
  const buffer = Buffer.from(String(rawTxHex || '').trim(), 'hex');
  if (buffer.length < 10) {
    throw new Error('invalid tx hex');
  }

  let offset = 4; // version
  const inputCount = readVarInt(buffer, offset);
  offset = inputCount.nextOffset;

  for (let index = 0; index < inputCount.value; index += 1) {
    offset += 32; // prev txid
    offset += 4; // prev output index
    const scriptLength = readVarInt(buffer, offset);
    offset = scriptLength.nextOffset + scriptLength.value;
    offset += 4; // sequence
  }

  const outputCount = readVarInt(buffer, offset);
  offset = outputCount.nextOffset;
  const outputs: Array<{ outputIndex: number; satoshis: number; scriptHex: string }> = [];
  for (let outputIndex = 0; outputIndex < outputCount.value; outputIndex += 1) {
    const satoshis = readUInt64LENumber(buffer, offset);
    offset += 8;
    const scriptLength = readVarInt(buffer, offset);
    offset = scriptLength.nextOffset;
    const scriptHex = buffer.subarray(offset, offset + scriptLength.value).toString('hex');
    offset += scriptLength.value;
    outputs.push({
      outputIndex,
      satoshis,
      scriptHex,
    });
  }
  return outputs;
}

function isMatchingP2pkhScript(scriptHex: string, pubkeyHashHex: string): boolean {
  return scriptHex.toLowerCase() === `76a914${pubkeyHashHex.toLowerCase()}88ac`;
}

function normalizeOutpointList(input: readonly string[] | null | undefined): Set<string> {
  return new Set(
    Array.from(input ?? [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => /^[0-9a-f]{64}:\d+$/.test(value)),
  );
}

function normalizeRecentTransactions(
  recentPinTransactions: readonly RecentMvcPinTransaction[],
): RecentMvcPinTransaction[] {
  const deduped = new Map<string, RecentMvcPinTransaction>();
  for (const item of recentPinTransactions) {
    const txid = String(item?.txid || '').trim().toLowerCase();
    const timestamp = Number(item?.timestamp ?? 0);
    if (!/^[0-9a-f]{64}$/.test(txid)) continue;
    const next: RecentMvcPinTransaction = {
      txid,
      timestamp: Number.isFinite(timestamp) ? Math.trunc(timestamp) : 0,
    };
    const existing = deduped.get(txid);
    if (!existing || next.timestamp > existing.timestamp) {
      deduped.set(txid, next);
    }
  }
  return Array.from(deduped.values()).sort((left, right) => right.timestamp - left.timestamp);
}

export function extractMvcFundingCandidatesFromPinTxHex(
  txHex: string,
  address: string,
): MvcCachedFundingUtxo[] {
  const normalizedAddress = String(address || '').trim();
  if (!normalizedAddress) return [];
  const p2pkhHashHex = getP2pkhHashHexFromAddress(normalizedAddress);
  if (!p2pkhHashHex) return [];
  const outputs = extractTxOutputs(txHex);
  const candidates: MvcCachedFundingUtxo[] = [];
  const normalizedTxHex = String(txHex || '').trim();
  const txId = normalizedTxHex ? computeMvcTxidFromRawTx(normalizedTxHex) : '';
  if (!txId) return [];

  for (const output of outputs) {
    const satoshis = Number(output.satoshis);
    if (!Number.isFinite(satoshis) || satoshis < MIN_MVC_FUNDING_SATOSHIS) continue;
    if (!isMatchingP2pkhScript(output.scriptHex, p2pkhHashHex)) continue;
    candidates.push({
      txId,
      outputIndex: output.outputIndex,
      satoshis,
      address: normalizedAddress,
      height: -1,
    });
  }
  return candidates.sort((left, right) => {
    if (right.satoshis !== left.satoshis) return right.satoshis - left.satoshis;
    return left.outputIndex - right.outputIndex;
  });
}

export async function fetchMvcTxHex(txid: string): Promise<string> {
  const normalizedTxid = String(txid || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedTxid)) {
    throw new Error('txid is required');
  }

  const response = await fetch(
    `${METALET_HOST}/wallet-api/v4/mvc/tx/raw?net=${NET}&txId=${encodeURIComponent(normalizedTxid)}`,
  );
  const json = await response.json() as {
    code?: number;
    message?: string;
    data?: { hex?: string; rawTx?: string } | string;
  };
  if (json?.code !== 0 && json?.code !== undefined) {
    throw new Error(json?.message || 'Failed to fetch MVC tx hex');
  }
  const data = json?.data;
  const rawTx = typeof data === 'string'
    ? data
    : data?.hex ?? data?.rawTx ?? '';
  const normalizedHex = String(rawTx || '').trim();
  if (!normalizedHex) {
    throw new Error(`No raw tx found for ${normalizedTxid}`);
  }
  return normalizedHex;
}

export async function recoverMvcFundingCandidatesFromPinHistory(params: {
  address: string;
  recentPinTransactions: readonly RecentMvcPinTransaction[];
  excludedOutpoints?: readonly string[];
  fetchTxHex?: (txid: string) => Promise<string>;
  maxCandidates?: number;
  onRecoverError?: (input: { txid: string; error: string }) => void;
}): Promise<MvcCachedFundingUtxo[]> {
  const normalizedAddress = String(params.address || '').trim();
  if (!normalizedAddress) return [];

  const excludedOutpoints = normalizeOutpointList(params.excludedOutpoints);
  const maxCandidates = Number.isFinite(params.maxCandidates) && (params.maxCandidates ?? 0) > 0
    ? Math.max(1, Math.trunc(params.maxCandidates as number))
    : 4;
  const fetchTxHex = params.fetchTxHex ?? fetchMvcTxHex;
  const recentTransactions = normalizeRecentTransactions(params.recentPinTransactions);
  const recovered: MvcCachedFundingUtxo[] = [];
  const seenOutpoints = new Set<string>();

  for (const item of recentTransactions) {
    if (recovered.length >= maxCandidates) break;
    let txHex = '';
    try {
      txHex = await fetchTxHex(item.txid);
    } catch (error) {
      params.onRecoverError?.({
        txid: item.txid,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const candidates = extractMvcFundingCandidatesFromPinTxHex(txHex, normalizedAddress);
    for (const candidate of candidates) {
      const outpoint = getMvcCachedFundingOutpointKey(candidate);
      if (excludedOutpoints.has(outpoint) || seenOutpoints.has(outpoint)) continue;
      seenOutpoints.add(outpoint);
      recovered.push(candidate);
      if (recovered.length >= maxCandidates) break;
    }
  }

  return recovered;
}

export function mergeMvcFundingCandidates(
  primary: readonly MvcCachedFundingUtxo[],
  secondary: readonly MvcCachedFundingUtxo[],
): MvcCachedFundingUtxo[] {
  const merged: MvcCachedFundingUtxo[] = [];
  const seenOutpoints = new Set<string>();

  for (const candidate of primary.concat(secondary)) {
    const normalized = candidate && typeof candidate === 'object'
      ? {
        txId: String(candidate.txId || '').trim().toLowerCase(),
        outputIndex: Number(candidate.outputIndex),
        satoshis: Number(candidate.satoshis),
        address: String(candidate.address || '').trim(),
        height: Number(candidate.height ?? -1),
      }
      : null;
    if (!normalized) continue;
    if (!/^[0-9a-f]{64}$/.test(normalized.txId)) continue;
    if (!Number.isInteger(normalized.outputIndex) || normalized.outputIndex < 0) continue;
    if (!Number.isFinite(normalized.satoshis) || normalized.satoshis < MIN_MVC_FUNDING_SATOSHIS) continue;
    if (!normalized.address) continue;
    const outpoint = getMvcCachedFundingOutpointKey(normalized);
    if (seenOutpoints.has(outpoint)) continue;
    seenOutpoints.add(outpoint);
    merged.push(normalized);
  }

  return merged;
}
