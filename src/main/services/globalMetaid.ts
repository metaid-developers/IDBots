/**
 * GlobalMetaId utility - converts blockchain addresses (MVC, BTC, DOGE) to unified GlobalMetaId.
 * Ported from: https://github.com/metaid-developers/metalet-extension-next/blob/main/src/lib/global-metaid.ts
 *
 * Addresses with the same derivation path produce the same GlobalMetaId (shared pubkey hash).
 */

import { createHash } from 'crypto';

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
  try {
    const addr = globalMetaId.toLowerCase();

    if (!addr.startsWith('id')) {
      return false;
    }

    const versionChar = addr[2];
    if (!VERSION_CHARS.includes(versionChar)) {
      return false;
    }

    if (addr[3] !== '1') {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
