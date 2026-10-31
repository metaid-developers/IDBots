/**
 * Pure (node-only) core for the MVC FT TokenSell capability.
 *
 * Everything in this module is byte-level and dependency-free apart from
 * node:crypto — no meta-contract, no electron — so it can be unit-tested
 * offline (`node --test`) and imported by the worker, the service and the
 * tests alike.
 *
 * Provenance (live-fire validated 2026-10-29/30, see docs/token-sell-protocol.md):
 * - v10 txid formula and the 112B header: mvc-lib `Transaction.newTxHeader`
 *   (version >= 10), cross-validated byte-level against the live merge tx
 *   f518099d… (header fixture hash256 display == the on-chain txid).
 * - Checker kill-switch: a deployed TokenTransferCheck lock is exactly
 *   84B code header ‖ tokenTransferCheck_desc template bytes (3507B total);
 *   sha256(deployed lock) == 128d88f8… for the live checker cast.
 * - Seed lock factory: tokenSell_desc.json template with <mvcRecAddr> /
 *   <mvcRecAmount> placeholders (scrypt sign-magnitude minimal int encoding,
 *   live 5e8 price → `04 0065cd1d`).
 * - Amount gates: 1 SPACE = 1e8 sats; listings must consume the token utxo
 *   in full (partial-quantity listings break the checker's conservation and
 *   are rejected at construction).
 */

import { createHash } from 'crypto';

// ---------- units & floors ----------
export const SATS_PER_SPACE = 100_000_000n; // 1 SPACE = 1e8 sats — never mix units.
export const DUST_SATS = 600n; // MVP minimum output (dust floor, skill-manual scale).
export const DEFAULT_SEED_SATS = 2032n; // live-fire seed denomination (anchor map P-6).
export const MIN_SELL_PRICE_SATS = 600n; // ask price floor: an output below dust is unspendable.

export function spaceToSats(space: number | string): bigint {
  const value = typeof space === 'string' ? Number(space) : space;
  if (!Number.isFinite(value) || value <= 0) throw new Error('space amount must be a positive number');
  const sats = Math.round(value * Number(SATS_PER_SPACE));
  if (!Number.isSafeInteger(sats) || sats <= 0) throw new Error('space amount out of sats range');
  return BigInt(sats);
}

export function satsToSpaceString(sats: number | bigint): string {
  return (Number(sats) / Number(SATS_PER_SPACE)).toFixed(8);
}

// ---------- base58 / hash helpers (TokenSell factory lineage) ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58ToHash160(addrB58: string): Buffer {
  let n = 0n;
  for (const c of addrB58) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`bad b58 char: ${c}`);
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const body = Buffer.from(hex, 'hex');
  const zeros = (addrB58.match(/^1*/) || [''])[0].length;
  const raw = Buffer.concat([Buffer.alloc(zeros), body]);
  if (raw.length < 5) throw new Error('b58 payload too short');
  const payload = raw.subarray(0, raw.length - 4);
  const ck = raw.subarray(raw.length - 4);
  const dbl = createHash('sha256')
    .update(createHash('sha256').update(payload).digest())
    .digest();
  if (!dbl.subarray(0, 4).equals(ck)) throw new Error('b58 checksum mismatch');
  if (payload[0] !== 0x00) throw new Error('unexpected version byte (want P2PKH 0x00)');
  return payload.subarray(1);
}

// scrypt sign-magnitude minimal little-endian int (serializer.js BN.toSM shape;
// live evidence: 5e8 price → 04 0065cd1d).
export function encodeScryptInt(v: bigint | number): Buffer {
  const value = BigInt(v);
  if (value === 0n) return Buffer.from([0x00]);
  const neg = value < 0n;
  const mag = neg ? -value : value;
  let hex = mag.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let le = Buffer.from(hex, 'hex').reverse();
  if (le[le.length - 1] & 0x80) le = Buffer.concat([le, Buffer.from([0x00])]);
  if (neg) le[le.length - 1] |= 0x80;
  return le;
}

export interface TokenSellDescLike {
  contract?: string;
  hex?: string;
}

function requireTokenSellDesc(desc: TokenSellDescLike): string {
  if (!desc || desc.contract !== 'TokenSell' || typeof desc.hex !== 'string' || !desc.hex) {
    throw new Error('TokenSell desc expected: { contract: "TokenSell", hex: template }');
  }
  return desc.hex;
}

/** TokenSell seed lock: desc template with seller hash160 + price substituted. */
export function buildTokenSellSeedLock(desc: TokenSellDescLike, sellerAddressB58: string, priceSats: bigint | number): Buffer {
  const template = requireTokenSellDesc(desc);
  const addr20 = b58ToHash160(sellerAddressB58);
  const parts = template.split(/(<mvcRecAddr>|<mvcRecAmount>)/);
  const priceBytes = encodeScryptInt(BigInt(priceSats));
  const pricePush = priceBytes.length.toString(16).padStart(2, '0') + priceBytes.toString('hex');
  const body = parts
    .map((p) =>
      p === '<mvcRecAddr>'
        ? '14' + addr20.toString('hex')
        : p === '<mvcRecAmount>'
          ? pricePush
          : p,
    )
    .join('');
  const lock = Buffer.from(body, 'hex');
  if (lock.length < 100) throw new Error('seed lock implausibly short — desc template malformed?');
  return lock;
}

/**
 * Decode a TokenSell seed lock back into (seller hash160, price sats) by
 * re-deriving the template around the two ctor slots. Used by the read path
 * to verify a listing's seed without trusting the counterparty's claims.
 */
export function decodeTokenSellSeedLock(lock: Buffer, desc: TokenSellDescLike): { sellerHash160Hex: string; priceSats: bigint } {
  const template = requireTokenSellDesc(desc);
  const parts = template.split(/(<mvcRecAddr>|<mvcRecAmount>)/);
  // Template alternates literal | placeholder | literal | placeholder | literal.
  let sellerHash160Hex = '';
  let priceBytes: Buffer | null = null;
  let cursor = 0;
  for (const part of parts) {
    if (part === '<mvcRecAddr>') {
      // the builder inserts OP_PUSH20 (0x14) before the 20B hash160
      if (cursor + 21 > lock.length) throw new Error('seed lock too short for seller slot');
      if (lock[cursor] !== 0x14) throw new Error('seller slot is not a 20-byte push');
      sellerHash160Hex = lock.subarray(cursor + 1, cursor + 21).toString('hex');
      cursor += 21;
    } else if (part === '<mvcRecAmount>') {
      // The push that follows is <pushLen><sign-magnitude LE bytes>; the next
      // template literal lets us bound the slot, but the push is
      // self-delimiting: read its length byte, validate < 9.
      if (cursor >= lock.length) throw new Error('seed lock too short for price slot');
      const len = lock[cursor];
      if (len === 0 || len > 8) throw new Error(`implausible price push length ${len}`);
      priceBytes = lock.subarray(cursor + 1, cursor + 1 + len);
      cursor += 1 + len;
    } else {
      const literal = Buffer.from(part, 'hex');
      if (!lock.subarray(cursor, cursor + literal.length).equals(literal)) {
        throw new Error('seed lock does not match TokenSell desc template');
      }
      cursor += literal.length;
    }
  }
  if (cursor !== lock.length) throw new Error('seed lock has trailing bytes beyond the template');
  if (!sellerHash160Hex || !priceBytes) throw new Error('template placeholders not consumed');
  return { sellerHash160Hex, priceSats: decodeScryptInt(priceBytes) };
}

export function decodeScryptInt(buf: Buffer): bigint {
  if (buf.length === 0) return 0n;
  const neg = !!(buf[buf.length - 1] & 0x80);
  const mag = Buffer.from(buf);
  mag[mag.length - 1] &= 0x7f;
  let hex = mag.reverse().toString('hex');
  if (hex.length % 2) hex = '0' + hex;
  const value = BigInt('0x' + (hex || '0'));
  return neg ? -value : value;
}

// ---------- v10 txid (112B header) ----------
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();
const dsha256 = (b: Buffer) => sha256(sha256(b));

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  const first = buf[offset];
  if (first < 0xfd) return { value: first, next: offset + 1 };
  if (first === 0xfd) return { value: buf.readUInt16LE(offset + 1), next: offset + 3 };
  if (first === 0xfe) return { value: buf.readUInt32LE(offset + 1), next: offset + 5 };
  const hi = buf.readUInt32LE(offset + 5);
  const lo = buf.readUInt32LE(offset + 1);
  return { value: hi * 0x100000000 + lo, next: offset + 9 };
}

export interface ParsedRawTx {
  version: number;
  locktime: number;
  inputs: Array<{ prevTxId: Buffer; outputIndex: number; scriptSig: Buffer; sequence: number }>;
  outputs: Array<{ satoshis: bigint; scriptPubKey: Buffer }>;
}

/** Minimal wire-format tx parser (what the v10 header needs, nothing more). */
export function parseRawTx(raw: Buffer | string): ParsedRawTx {
  const buf = typeof raw === 'string' ? Buffer.from(raw.trim().toLowerCase(), 'hex') : raw;
  let o = 0;
  const version = buf.readInt32LE(o); o += 4;
  const nIn = readVarint(buf, o); o = nIn.next;
  const inputs: ParsedRawTx['inputs'] = [];
  for (let i = 0; i < nIn.value; i++) {
    const prevTxId = buf.subarray(o, o + 32); o += 32;
    const outputIndex = buf.readUInt32LE(o); o += 4;
    const scriptLen = readVarint(buf, o); o = scriptLen.next;
    const scriptSig = buf.subarray(o, o + scriptLen.value); o += scriptLen.value;
    const sequence = buf.readUInt32LE(o); o += 4;
    inputs.push({ prevTxId: Buffer.from(prevTxId), outputIndex, scriptSig: Buffer.from(scriptSig), sequence });
  }
  const nOut = readVarint(buf, o); o = nOut.next;
  const outputs: ParsedRawTx['outputs'] = [];
  for (let i = 0; i < nOut.value; i++) {
    const satoshis = buf.readBigUInt64LE(o); o += 8;
    const scriptLen = readVarint(buf, o); o = scriptLen.next;
    const scriptPubKey = buf.subarray(o, o + scriptLen.value); o += scriptLen.value;
    outputs.push({ satoshis, scriptPubKey: Buffer.from(scriptPubKey) });
  }
  const locktime = buf.readUInt32LE(o); o += 4;
  if (o !== buf.length) throw new Error(`raw tx has ${buf.length - o} trailing bytes`);
  return { version, locktime, inputs, outputs };
}

/**
 * MVC v10 consensus header (112 bytes for ordinary nIn/nOut):
 *   u32LE(version) ‖ u32LE(locktime) ‖ i32LE(nIn) ‖ i32LE(nOut)
 *   ‖ inRoot ‖ scriptRoot ‖ outRoot
 * where inRoot    = sha256( Σ per input  reverse(prevTxId wire bytes) ‖ u32LE(vout) ‖ u32LE(sequence) )
 *       scriptRoot= sha256( Σ per input  sha256(scriptSig) )
 *       outRoot   = sha256( Σ per output u64LE(sats) ‖ sha256(scriptPubKey) )
 * Mirrors mvc-lib Transaction.newTxHeader exactly (txid = reverse(hash256(header))).
 */
export function extractV10Header(raw: Buffer | string): Buffer {
  const tx = parseRawTx(raw);
  return buildV10Header(tx);
}

export function buildV10Header(tx: ParsedRawTx): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(tx.version >>> 0, 0);
  header.writeUInt32LE(tx.locktime >>> 0, 4);
  header.writeInt32LE(tx.inputs.length, 8);
  header.writeInt32LE(tx.outputs.length, 12);

  const inWriter: Buffer[] = [];
  const scriptWriter: Buffer[] = [];
  for (const input of tx.inputs) {
    const entry = Buffer.alloc(40);
    // Wire order, verbatim: MVC v10 serializes prevTxId so the raw wire bytes
    // enter inRoot unchanged (anchor-map #1; validated against f518099d).
    Buffer.from(input.prevTxId).copy(entry, 0);
    entry.writeUInt32LE(input.outputIndex, 32);
    entry.writeUInt32LE(input.sequence, 36);
    inWriter.push(entry);
    scriptWriter.push(sha256(input.scriptSig));
  }
  const outWriter: Buffer[] = [];
  for (const output of tx.outputs) {
    const entry = Buffer.alloc(40);
    entry.writeBigUInt64LE(output.satoshis, 0);
    sha256(output.scriptPubKey).copy(entry, 8);
    outWriter.push(entry);
  }
  return Buffer.concat([
    header,
    sha256(Buffer.concat(inWriter)),
    sha256(Buffer.concat(scriptWriter)),
    sha256(Buffer.concat(outWriter)),
  ]);
}

/** Consensus display txid of a v10 raw tx: reverse(hash256(112B header)). */
export function v10TxId(raw: Buffer | string): string {
  return dsha256(extractV10Header(raw)).reverse().toString('hex');
}

// ---------- checker kill-switch ----------
export interface CheckerKillSwitch {
  ok: boolean;
  totalLen: number;
  codeHeaderLen: number;
  descBytesLen: number;
}

/**
 * Deployed TokenTransferCheck lock == desc template bytes ‖ trailing 84B
 * dataPart tail (OP_RETURN OP_PUSHDATA1 <len> ‖ dataPart — carries
 * tokenCodeHash/tokenID/amounts/receivers). Live anchor: total 3507B =
 * 3423B desc template + 84B tail; the tail embeds the amount-conservation
 * pairing the LIST leg depends on. Byte-verified against the live checker
 * cast consumed by the live listing e281d9a2… (sha256(lock)=128d88f8…).
 */
export function checkerKillSwitch(lock: Buffer, descTemplateHex: string): CheckerKillSwitch {
  const descBytes = Buffer.from(String(descTemplateHex || '').replace(/[^0-9a-f]/gi, ''), 'hex');
  const DATA_TAIL_LEN = 84;
  const ok =
    lock.length === descBytes.length + DATA_TAIL_LEN &&
    lock.length > DATA_TAIL_LEN &&
    lock[lock.length - DATA_TAIL_LEN] === 0x6a &&
    lock[lock.length - DATA_TAIL_LEN + 1] === 0x4c &&
    lock.subarray(0, lock.length - DATA_TAIL_LEN).equals(descBytes);
  return {
    ok,
    totalLen: lock.length,
    codeHeaderLen: DATA_TAIL_LEN,
    descBytesLen: descBytes.length,
  };
}

// ---------- amount gates (construction-path hard gates) ----------
export interface TokenSellAmountGatesInput {
  /** Ask price in sats (integer). */
  priceSats: number | bigint;
  /** Token quantity being listed, base units (integer string/BigInt). */
  listedTokenAmount: bigint;
  /** The token utxo's dataPart amount — the listing must consume it IN FULL. */
  utxoTokenAmount: bigint;
  /** Seed utxo denomination in sats. */
  seedSats?: number | bigint;
  /** Checker utxo denomination in sats. */
  checkerSats?: number | bigint;
}

export interface TokenSellAmountGatesResult {
  ok: boolean;
  violations: string[];
}

/**
 * Hard gates enforced before any tx assembly:
 *  - price is a positive integer ≥ dust floor, in SATS (never SPACE-mixed);
 *  - listed token amount == the token utxo's full dataPart amount
 *    (partial-quantity listings break the checker's conservation invariant —
 *    live-fire evidence: checker receiverTokenAmountArray must equal the
 *    listed amount and the token output carries the same amount);
 *  - seed / checker utxo denominations ≥ dust.
 */
export function checkTokenSellAmountGates(input: TokenSellAmountGatesInput): TokenSellAmountGatesResult {
  const violations: string[] = [];
  const price = BigInt(input.priceSats ?? 0);
  if (price <= 0n) violations.push('price_sats must be a positive integer (sats, not SPACE)');
  else if (price < MIN_SELL_PRICE_SATS) violations.push(`price_sats below dust floor ${MIN_SELL_PRICE_SATS}`);
  if (input.listedTokenAmount <= 0n) violations.push('listed token amount must be positive');
  if (input.utxoTokenAmount <= 0n) violations.push('token utxo amount must be positive');
  if (input.listedTokenAmount !== input.utxoTokenAmount) {
    violations.push(
      `partial-fill listing rejected: listed ${input.listedTokenAmount} != utxo ${input.utxoTokenAmount} ` +
        '(TokenSell checker conservation requires the full utxo; split the token first if you need a smaller listing)',
    );
  }
  if (input.seedSats !== undefined && BigInt(input.seedSats) < DUST_SATS) {
    violations.push(`seed_sats ${input.seedSats} below dust ${DUST_SATS}`);
  }
  if (input.checkerSats !== undefined && BigInt(input.checkerSats) < DUST_SATS) {
    violations.push(`checker_sats ${input.checkerSats} below dust ${DUST_SATS}`);
  }
  return { ok: violations.length === 0, violations };
}

export function assertTokenSellAmountGates(input: TokenSellAmountGatesInput): void {
  const result = checkTokenSellAmountGates(input);
  if (!result.ok) throw new Error(`TokenSell amount gates: ${result.violations.join('; ')}`);
}

// ---------- transfer (op=1 TRANSFER, non-trade) amount gates ----------

export interface TokenTransferAmountGatesInput {
  /** Token amount being transferred, base units (integer). */
  transferTokenAmount: bigint;
  /** The token utxo's dataPart amount — a TRANSFER moves it IN FULL. */
  utxoTokenAmount: bigint;
  /** Checker utxo denomination in sats (auto-minted TransferCheck cast). */
  checkerSats?: number | bigint;
}

/**
 * Hard gates for the non-trade op=1 TRANSFER path (wallet_token_transfer):
 *  - no partial moves: the token utxo is transferred IN FULL (the checker
 *    conservation pairs the TransferCheck receiver amount with the token
 *    output amount; splitting needs the listing/precise-split path);
 *  - checker denomination (when given) ≥ dust, in SATS units.
 *    There is no price in a transfer — price gates belong to TokenSell.
 */
export function checkTokenTransferAmountGates(input: TokenTransferAmountGatesInput): TokenSellAmountGatesResult {
  const violations: string[] = [];
  if (input.transferTokenAmount <= 0n) violations.push('transfer token amount must be positive');
  if (input.utxoTokenAmount <= 0n) violations.push('token utxo amount must be positive');
  if (input.transferTokenAmount !== input.utxoTokenAmount) {
    violations.push(
      `partial transfer rejected: transfer ${input.transferTokenAmount} != utxo ${input.utxoTokenAmount} ` +
        '(op=1 TRANSFER moves the token utxo in full; split the token first if you need a smaller amount)',
    );
  }
  if (input.checkerSats !== undefined && BigInt(input.checkerSats) < DUST_SATS) {
    violations.push(`checker_sats ${input.checkerSats} below dust ${DUST_SATS}`);
  }
  return { ok: violations.length === 0, violations };
}

export function assertTokenTransferAmountGates(input: TokenTransferAmountGatesInput): void {
  const result = checkTokenTransferAmountGates(input);
  if (!result.ok) throw new Error(`TokenTransfer amount gates: ${result.violations.join('; ')}`);
}
