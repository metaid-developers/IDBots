/**
 * GlobalMetaId utility - converts blockchain addresses (MVC, BTC, DOGE) to unified GlobalMetaId.
 * Ported from: https://github.com/metaid-developers/metalet-extension-next/blob/main/src/lib/global-metaid.ts
 *
 * Addresses with the same derivation path produce the same GlobalMetaId (shared pubkey hash).
 */

import { createHash } from 'crypto';
import { normalizeRawGlobalMetaId } from '../shared/globalMetaId';

// ============= Address Version Types =============

enum AddressVersion {
  P2PKH = 0,
  P2SH = 1,
  P2WPKH = 2,
  P2WSH = 3,
  P2MS = 4,
  P2TR = 5,
}

// ============= SHA256 =============

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

function doubleSHA256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

// ============= Base58 Encode/Decode =============

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);

  let num = BigInt(0);
  for (const char of str) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid Base58 character: ${char}`);
    }
    num = num * BigInt(58) + BigInt(index);
  }

  const bytes: number[] = [];
  while (num > 0) {
    bytes.unshift(Number(num % BigInt(256)));
    num = num / BigInt(256);
  }

  for (const char of str) {
    if (char === '1') {
      bytes.unshift(0);
    } else {
      break;
    }
  }

  return new Uint8Array(bytes);
}

function base58CheckDecode(str: string): { version: number; payload: Uint8Array } {
  const decoded = base58Decode(str);

  if (decoded.length < 5) {
    throw new Error('Decoded data too short');
  }

  const data = decoded.slice(0, -4);
  const checksum = decoded.slice(-4);

  const expectedChecksum = doubleSHA256(data);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expectedChecksum[i]) {
      throw new Error('Checksum mismatch');
    }
  }

  return {
    version: data[0],
    payload: data.slice(1),
  };
}

// ============= Bech32 Encode/Decode =============

enum Bech32Encoding {
  Bech32 = 1,
  Bech32m = 2,
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CHARSET_MAP: Record<string, number> = {};
for (let i = 0; i < BECH32_CHARSET.length; i++) {
  BECH32_CHARSET_MAP[BECH32_CHARSET[i]] = i;
}

function bech32Polymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) {
        chk ^= gen[i];
      }
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const result: number[] = [];
  for (let i = 0; i < hrp.length; i++) {
    result.push(hrp.charCodeAt(i) >> 5);
  }
  result.push(0);
  for (let i = 0; i < hrp.length; i++) {
    result.push(hrp.charCodeAt(i) & 31);
  }
  return result;
}

function bech32VerifyChecksum(hrp: string, data: number[], encoding: Bech32Encoding): boolean {
  const values = [...bech32HrpExpand(hrp), ...data];
  const polymod = bech32Polymod(values);

  const bech32Const = 1;
  const bech32mConst = 0x2bc830a3;

  return encoding === Bech32Encoding.Bech32 ? polymod === bech32Const : polymod === bech32mConst;
}

function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): Uint8Array {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  const maxv = (1 << toBits) - 1;

  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxv);
    }
  }

  if (pad) {
    if (bits > 0) {
      result.push((acc << (toBits - bits)) & maxv);
    }
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    throw new Error('Invalid padding');
  }

  return new Uint8Array(result);
}

function bech32Decode(addr: string): {
  hrp: string;
  version: number;
  program: Uint8Array;
  encoding: Bech32Encoding;
} {
  addr = addr.toLowerCase();

  const pos = addr.lastIndexOf('1');
  if (pos < 1 || pos + 7 > addr.length || addr.length > 90) {
    throw new Error('Invalid bech32 address format');
  }

  const hrp = addr.slice(0, pos);
  const data = addr.slice(pos + 1);

  const decoded: number[] = [];
  for (const char of data) {
    const val = BECH32_CHARSET_MAP[char];
    if (val === undefined) {
      throw new Error(`Invalid bech32 character: ${char}`);
    }
    decoded.push(val);
  }

  let encoding = Bech32Encoding.Bech32m;
  if (!bech32VerifyChecksum(hrp, decoded, Bech32Encoding.Bech32m)) {
    encoding = Bech32Encoding.Bech32;
    if (!bech32VerifyChecksum(hrp, decoded, Bech32Encoding.Bech32)) {
      throw new Error('Invalid bech32 checksum');
    }
  }

  const dataWithoutChecksum = decoded.slice(0, -6);

  if (dataWithoutChecksum.length < 1) {
    throw new Error('Invalid bech32 data length');
  }

  const version = dataWithoutChecksum[0];

  const program = convertBits(new Uint8Array(dataWithoutChecksum.slice(1)), 5, 8, false);

  if (program.length < 2 || program.length > 40) {
    throw new Error('Invalid witness program length');
  }

  if (version === 0 && encoding !== Bech32Encoding.Bech32) {
    throw new Error('Witness version 0 must use bech32');
  }
  if (version !== 0 && encoding !== Bech32Encoding.Bech32m) {
    throw new Error('Witness version 1+ must use bech32m');
  }

  return { hrp, version, program, encoding };
}

// ============= IDAddress Encode/Decode =============

const IDADDRESS_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const VERSION_CHARS = ['q', 'p', 'z', 'r', 'y', 't'];

function idPolymod(values: number[]): number {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) {
        chk ^= gen[i];
      }
    }
  }
  return chk;
}

function idHrpExpand(hrp: string): number[] {
  const result: number[] = [];
  for (let i = 0; i < hrp.length; i++) {
    result.push(hrp.charCodeAt(i) >> 5);
  }
  result.push(0);
  for (let i = 0; i < hrp.length; i++) {
    result.push(hrp.charCodeAt(i) & 31);
  }
  return result;
}

function createIdChecksum(data: number[], version: AddressVersion): number[] {
  const versionChar = VERSION_CHARS[version];
  const hrp = 'id' + versionChar;
  const values = [...idHrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = idPolymod(values) ^ 1;

  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) {
    checksum.push((mod >> (5 * (5 - i))) & 31);
  }
  return checksum;
}

function convertBits8to5(data: Uint8Array): number[] {
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  const maxv = 31;

  for (const value of data) {
    acc = (acc << 8) | value;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result.push((acc >> bits) & maxv);
    }
  }

  if (bits > 0) {
    result.push((acc << (5 - bits)) & maxv);
  }

  return result;
}

function encodeIDAddress(version: AddressVersion, data: Uint8Array): string {
  if (version < 0 || version > 5) {
    throw new Error(`Invalid version: ${version}`);
  }

  const converted = convertBits8to5(data);
  const checksum = createIdChecksum(converted, version);
  const finalData = [...converted, ...checksum];

  const versionChar = VERSION_CHARS[version];
  let result = 'id' + versionChar + '1';
  for (const d of finalData) {
    result += IDADDRESS_CHARSET[d];
  }

  return result;
}

// ============= Address Conversion =============

function convertFromLegacyAddress(version: number, payload: Uint8Array): string {
  let idVersion: AddressVersion;

  switch (version) {
    case 0x00:
    case 0x6f:
    case 0x1e:
      idVersion = AddressVersion.P2PKH;
      break;
    case 0x05:
    case 0xc4:
    case 0x16:
      idVersion = AddressVersion.P2SH;
      break;
    default:
      throw new Error(`Unsupported version byte: 0x${version.toString(16)}`);
  }

  return encodeIDAddress(idVersion, payload);
}

function convertFromSegWitAddress(hrp: string, witnessVersion: number, program: Uint8Array): string {
  if (hrp !== 'bc' && hrp !== 'tb') {
    throw new Error(`Unsupported network: ${hrp}`);
  }

  switch (witnessVersion) {
    case 0:
      if (program.length === 20) {
        return encodeIDAddress(AddressVersion.P2WPKH, program);
      } else if (program.length === 32) {
        return encodeIDAddress(AddressVersion.P2WSH, program);
      }
      throw new Error(`Invalid witness v0 program length: ${program.length}`);
    case 1:
      if (program.length === 32) {
        return encodeIDAddress(AddressVersion.P2TR, program);
      }
      throw new Error(`Invalid taproot program length: ${program.length}`);
    default:
      throw new Error(`Unsupported witness version: ${witnessVersion}`);
  }
}

/**
 * Convert a blockchain address to GlobalMetaId.
 * Supports Bitcoin (Legacy, SegWit, Taproot), Dogecoin, MVC addresses.
 *
 * @param address - Blockchain address (Base58Check or Bech32)
 * @returns GlobalMetaId string (starts with "id")
 */
export function convertToGlobalMetaId(address: string): string {
  try {
    const { version, payload } = base58CheckDecode(address);
    return convertFromLegacyAddress(version, payload);
  } catch {
    // fall through to Bech32
  }

  try {
    const { hrp, version, program } = bech32Decode(address);
    return convertFromSegWitAddress(hrp, version, program);
  } catch {
    throw new Error(`Unsupported address format: ${address}`);
  }
}

/**
 * Validate GlobalMetaId format.
 *
 * @param globalMetaId - GlobalMetaId to validate
 * @returns true if valid format
 */
export function validateGlobalMetaId(globalMetaId: string): boolean {
  return normalizeRawGlobalMetaId(globalMetaId) !== null;
}

/**
 * Decode a GlobalMetaId back into its version and payload (pubkey hash /
 * script hash / witness program). Inverse of encodeIDAddress.
 * Returns null for malformed input or checksum mismatch.
 */
export function decodeGlobalMetaIdPayload(globalMetaId: string): { version: number; payload: Uint8Array } | null {
  const normalized = normalizeRawGlobalMetaId(globalMetaId);
  if (!normalized) return null;

  const version = VERSION_CHARS.indexOf(normalized[2]);
  if (version < 0) return null;

  // Strip 'id' + versionChar + '1'; the last 6 values are the checksum.
  const body = normalized.slice(4);
  if (!body || body.length <= 6) return null;

  const values: number[] = [];
  for (const char of body) {
    const idx = IDADDRESS_CHARSET.indexOf(char);
    if (idx === -1) return null;
    values.push(idx);
  }

  const data = values.slice(0, -6);
  const checksum = values.slice(-6);
  const expectedChecksum = createIdChecksum(data, version as AddressVersion);
  for (let i = 0; i < 6; i++) {
    if (checksum[i] !== expectedChecksum[i]) return null;
  }

  let payload: Uint8Array;
  try {
    payload = convertBits(new Uint8Array(data), 5, 8, false);
  } catch {
    return null;
  }
  if (payload.length === 0) return null;
  return { version, payload };
}

export interface GlobalMetaIdAddressResolution {
  globalMetaId: string;
  version: number;
  addressType: 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2ms' | 'p2tr';
  payloadHex: string;
  /** MVC mainnet P2PKH address (derived offline when payload is a 20-byte pubkey hash160: idq1... or idz1...). */
  mvcAddress?: string;
  /** Primary BTC mainnet address matching the GlobalMetaID version (1... for idq1, 3... for idp1, bc1q... for idz1/idr1, bc1p... for idt1). */
  btcAddress?: string;
  /** BTC Legacy P2PKH (1...) when payload is 20-byte pubkey hash160. */
  btcLegacyAddress?: string;
  /** BTC Native SegWit P2WPKH (bc1q...) when payload is 20-byte pubkey hash160. */
  btcSegwitAddress?: string;
  /** DOGE mainnet address (D... for P2PKH/P2WPKH 20-byte hash160; 9/A... for P2SH). */
  dogeAddress?: string;
  note?: string;
}

function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  let num = 0n;
  for (const byte of bytes) {
    num = num * 256n + BigInt(byte);
  }

  let encoded = '';
  while (num > 0n) {
    const rem = Number(num % 58n);
    encoded = BASE58_ALPHABET[rem] + encoded;
    num = num / 58n;
  }

  for (const byte of bytes) {
    if (byte === 0) {
      encoded = '1' + encoded;
    } else {
      break;
    }
  }

  return encoded;
}

function base58CheckEncode(version: number, payload: Uint8Array): string {
  const data = new Uint8Array(1 + payload.length);
  data[0] = version & 0xff;
  data.set(payload, 1);
  const checksum = doubleSHA256(data).slice(0, 4);
  const full = new Uint8Array(data.length + 4);
  full.set(data, 0);
  full.set(checksum, data.length);
  return base58Encode(full);
}

function bech32CreateChecksum(hrp: string, data: number[], encoding: Bech32Encoding): number[] {
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const bech32Const = encoding === Bech32Encoding.Bech32 ? 1 : 0x2bc830a3;
  const polymod = bech32Polymod(values) ^ bech32Const;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) {
    checksum.push((polymod >> (5 * (5 - i))) & 31);
  }
  return checksum;
}

function bech32EncodeWitness(hrp: string, witnessVersion: number, program: Uint8Array): string {
  const encoding = witnessVersion === 0 ? Bech32Encoding.Bech32 : Bech32Encoding.Bech32m;
  const words = Array.from(convertBits(program, 8, 5, true));
  const data = [witnessVersion, ...words];
  const checksum = bech32CreateChecksum(hrp, data, encoding);
  let out = `${hrp}1`;
  for (const v of [...data, ...checksum]) {
    out += BECH32_CHARSET[v];
  }
  return out;
}

/**
 * Extract a normalized raw GlobalMetaID from either a bare GlobalMetaID
 * (`idq1...` / `idt1...`) or a `metaid://idq1...[/...]` URI.
 */
export function extractGlobalMetaIdCandidate(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let trimmed = input.trim();
  if (!trimmed) return null;
  if (/^metaid:\/\//i.test(trimmed)) {
    trimmed = trimmed.slice('metaid://'.length).split(/[/?#]/)[0]?.trim() ?? '';
  }
  return normalizeRawGlobalMetaId(trimmed);
}

/**
 * Deterministically decode a GlobalMetaID (`idq1...`, `idp1...`, `idz1...`,
 * `idr1...`, `idt1...`, or `metaid://idq1...`) offline into its corresponding
 * mainnet blockchain addresses (MVC, BTC Legacy/SegWit/Taproot, DOGE).
 *
 * Returns null when `input` is not a valid GlobalMetaID.
 */
export function convertGlobalMetaIdToAddresses(input: unknown): GlobalMetaIdAddressResolution | null {
  const candidate = extractGlobalMetaIdCandidate(input);
  if (!candidate) return null;
  const decoded = decodeGlobalMetaIdPayload(candidate);
  if (!decoded) return null;

  const { version, payload } = decoded;
  const payloadHex = Buffer.from(payload).toString('hex');

  if (version === AddressVersion.P2PKH && payload.length === 20) {
    const mvcAddress = base58CheckEncode(0x00, payload);
    const btcSegwitAddress = bech32EncodeWitness('bc', 0, payload);
    const dogeAddress = base58CheckEncode(0x1e, payload);
    return {
      globalMetaId: candidate,
      version,
      addressType: 'p2pkh',
      payloadHex,
      mvcAddress,
      btcAddress: mvcAddress,
      btcLegacyAddress: mvcAddress,
      btcSegwitAddress,
      dogeAddress,
    };
  }

  if (version === AddressVersion.P2SH && payload.length === 20) {
    const btcAddress = base58CheckEncode(0x05, payload);
    const dogeAddress = base58CheckEncode(0x16, payload);
    return {
      globalMetaId: candidate,
      version,
      addressType: 'p2sh',
      payloadHex,
      btcAddress,
      dogeAddress,
      note: 'P2SH script-hash GlobalMetaID (idp1...); MVC P2PKH/MetaContract requires a 20-byte pubkey hash160 (idq1...).',
    };
  }

  if (version === AddressVersion.P2WPKH && payload.length === 20) {
    const mvcAddress = base58CheckEncode(0x00, payload);
    const btcSegwitAddress = bech32EncodeWitness('bc', 0, payload);
    const dogeAddress = base58CheckEncode(0x1e, payload);
    return {
      globalMetaId: candidate,
      version,
      addressType: 'p2wpkh',
      payloadHex,
      mvcAddress,
      btcAddress: btcSegwitAddress,
      btcLegacyAddress: mvcAddress,
      btcSegwitAddress,
      dogeAddress,
    };
  }

  if (version === AddressVersion.P2WSH && payload.length === 32) {
    const btcAddress = bech32EncodeWitness('bc', 0, payload);
    return {
      globalMetaId: candidate,
      version,
      addressType: 'p2wsh',
      payloadHex,
      btcAddress,
      note: '32-byte BTC P2WSH GlobalMetaID (idr1...); cannot offline-derive a 20-byte MVC P2PKH address.',
    };
  }

  if (version === AddressVersion.P2TR && payload.length === 32) {
    const btcAddress = bech32EncodeWitness('bc', 1, payload);
    return {
      globalMetaId: candidate,
      version,
      addressType: 'p2tr',
      payloadHex,
      btcAddress,
      note: '32-byte BTC Taproot GlobalMetaID (idt1... -> bc1p...); cannot offline-derive a 20-byte MVC P2PKH address without an on-chain profile lookup.',
    };
  }

  return {
    globalMetaId: candidate,
    version,
    addressType: 'p2ms',
    payloadHex,
    note: `Unsupported GlobalMetaID payload shape (version=${version}, bytes=${payload.length}).`,
  };
}

