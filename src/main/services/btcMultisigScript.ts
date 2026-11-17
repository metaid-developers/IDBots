import * as bitcoin from 'bitcoinjs-lib';
import { BTC_MIN_SPENDABLE_SATS, isBtcSpendableSats } from './btcSpendPolicy';

const NETWORK = bitcoin.networks.bitcoin;
const MAX_KEYS = 16;
const CHECKMULTISIG = 0xae;
const OP_1 = 0x51;
const OP_16 = 0x60;
const OP_PUSHBYTES_33 = 0x21;
const SIGHASH_ALL = bitcoin.Transaction.SIGHASH_ALL;

/**
 * Last-ditch fee sanity for the builder. bitcoinjs' own extractTransaction
 * refuses >5000 sat/vB, but by then every signer has already been asked for a
 * signature; an absent change output (a 1000x fat-finger) must be caught when
 * the PSBT is built. 1000 sat/vB is ~10x the highest fee spikes ever seen on
 * Bitcoin, so no legitimate vault spend approaches it.
 */
const MAX_FEE_RATE_SAT_VB = 1000;
const WARN_FEE_RATE_SAT_VB = 200;

/** Parsed shape of a canonical P2WSH bare-multisig script. */
export interface MultisigScriptShape {
  m: number;
  n: number;
  pubkeys: Buffer[];
}

export interface MultisigDescriptor {
  m: number;
  n: number;
  pubkeys: string[];
  witnessScriptHex: string;
  address: string;
}

export interface MultisigSpendInput {
  txid: string;
  vout: number;
  value: number;
}

export interface MultisigSpendOutput {
  address: string;
  value: number;
}

export interface BuiltMultisigPsbt {
  psbtHex: string;
  feeSats: number;
  feeRateSatVb: number;
  warning?: string;
}

export interface PsbtIoSummary {
  txid: string;
  vout: number;
  value: number | null;
  partialSigs: number;
  sighashType: number;
}

export interface PsbtSummary {
  inputCount: number;
  outputCount: number;
  feeSats: number | null;
  inputs: PsbtIoSummary[];
  outputs: Array<{ address: string; value: number }>;
}

export interface RawTxSummary {
  txid: string;
  outputs: Array<{ address: string; value: number }>;
}

function fail(message: string): never {
  throw new Error(message);
}

function opcodeToSmallInt(opcode: number | undefined): number | null {
  if (opcode == null || opcode < OP_1 || opcode > OP_16) return null;
  return opcode - (OP_1 - 1);
}

function varIntLength(value: number): number {
  return value < 0xfd ? 1 : value <= 0xffff ? 3 : 5;
}

/**
 * Parse a canonical bare-multisig witness script:
 *   OP_m <33-byte pubkey>...<33-byte pubkey> OP_n OP_CHECKMULTISIG
 *
 * The previous check only looked at the last opcode, so `ae`, `51ae` and even
 * `OP_1 OP_CHECKMULTISIGVERIFY` (a script nobody can ever spend) were accepted
 * as "a multisig script". Anything that is not this exact shape is rejected.
 */
export function parseMultisigScriptShape(script: Buffer | undefined): MultisigScriptShape | null {
  if (!script || script.length < 1 + 34 + 2) return null;
  const m = opcodeToSmallInt(script[0]);
  if (m == null) return null;
  const pubkeys: Buffer[] = [];
  let offset = 1;
  while (offset < script.length && script[offset] === OP_PUSHBYTES_33) {
    if (offset + 34 > script.length) return null;
    const key = script.subarray(offset + 1, offset + 34);
    if (key[0] !== 0x02 && key[0] !== 0x03) return null;
    pubkeys.push(Buffer.from(key));
    offset += 34;
  }
  const n = opcodeToSmallInt(script[offset]);
  if (n == null) return null;
  if (script[offset + 1] !== CHECKMULTISIG) return null;
  if (script.length !== offset + 2) return null;
  if (n !== pubkeys.length || n > MAX_KEYS || m > n) return null;
  return { m, n, pubkeys };
}

/** Public shape-only view used by callers that only need m/n. */
export function parseMultisigScript(script: Buffer | undefined): { m: number; n: number } | null {
  const parsed = parseMultisigScriptShape(script);
  return parsed ? { m: parsed.m, n: parsed.n } : null;
}

function requireMultisigScript(script: Buffer | undefined): MultisigScriptShape {
  const parsed = parseMultisigScriptShape(script);
  if (!parsed) fail('witness script is not a canonical M-of-N multisig script');
  return parsed;
}

function normalizePubkey(value: string): string {
  const hex = String(value || '').trim().toLowerCase();
  if (!/^(02|03)[0-9a-f]{64}$/.test(hex)) {
    fail('pubkey must be a 33-byte compressed hex key');
  }
  return hex;
}

function txidOf(hash: Buffer): string {
  return Buffer.from(hash).reverse().toString('hex');
}

function addressOf(script: Buffer): string {
  try {
    return bitcoin.address.fromOutputScript(script, NETWORK);
  } catch {
    return `script:${script.toString('hex')}`;
  }
}

function readPsbt(psbtHex: string): bitcoin.Psbt {
  const hex = String(psbtHex || '').trim();
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 20) {
    fail('psbt hex is invalid');
  }
  try {
    return bitcoin.Psbt.fromHex(hex);
  } catch (error) {
    fail(`psbt hex is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function inputSighashType(input: { sighashType?: number } | undefined): number {
  return input?.sighashType ?? SIGHASH_ALL;
}

/**
 * SIGHASH_ALL is the only signature scope the multisig flow allows. SINGLE /
 * NONE / ANYONECANPAY let a co-signer's signature commit to less than the
 * whole transaction, so a PSBT carrying them must never be combined or
 * finalized by this tool (a malicious initiator could otherwise mutate the
 * other outputs after collecting them).
 */
function assertSighashAllInputs(psbt: bitcoin.Psbt): void {
  psbt.data.inputs.forEach((input, index) => {
    const type = inputSighashType(input);
    if (type !== SIGHASH_ALL) {
      fail(`input ${index} must use SIGHASH_ALL (got sighash type ${type})`);
    }
  });
}

/**
 * Validate that the selected inputs are spendable by this key and that every
 * witnessScript is actually the script committed to by its prevout.
 *
 * bitcoinjs enforces both at signInput time, but a check here (a) fails before
 * the owner is asked to approve a signature that cannot be produced and
 * (b) keeps the invariant owned by this tool instead of a library detail.
 */
export function assertMultisigInputsSignable(input: {
  psbtHex: string;
  indexes: number[];
  publicKey: string;
}): void {
  const psbt = readPsbt(input.psbtHex);
  const expected = Buffer.from(normalizePubkey(input.publicKey), 'hex');
  for (const index of input.indexes) {
    const data = psbt.data.inputs[index];
    if (!data) fail(`input ${index} is missing from the PSBT`);
    const shape = parseMultisigScriptShape(data.witnessScript);
    if (!shape) fail(`input ${index} is not a canonical multisig input`);
    if (!data.witnessUtxo) fail(`input ${index} is missing its witness UTXO`);
    const p2wsh = bitcoin.payments.p2wsh({
      redeem: { output: data.witnessScript, network: NETWORK },
      network: NETWORK,
    });
    if (!p2wsh.output || !p2wsh.output.equals(data.witnessUtxo.script)) {
      fail(`input ${index}: witness script does not match the prevout script`);
    }
    if (!shape.pubkeys.some((pubkey) => pubkey.equals(expected))) {
      fail(`input ${index}: this multisig script does not include this MetaBot's key`);
    }
  }
}

/**
 * Conservative vsize for a P2WSH m-of-n spend (signature = at most 73 bytes).
 * Used only for the fee-rate sanity gate; it errs high, which makes the gate
 * stricter, never looser.
 */
export function estimateMultisigSpendVsize(input: {
  witnessScriptHex: string;
  inputCount: number;
  outputScriptLengths: number[];
}): number {
  const script = Buffer.from(String(input.witnessScriptHex || '').trim(), 'hex');
  const shape = requireMultisigScript(script);
  const base = 4 + 4
    + varIntLength(input.inputCount)
    + varIntLength(input.outputScriptLengths.length)
    + input.inputCount * 41
    + input.outputScriptLengths.reduce((sum, length) => sum + 8 + varIntLength(length) + length, 0);
  const witnessPerInput = 1 + 1 + shape.m * 74 + varIntLength(script.length) + script.length;
  return Math.ceil((base * 4 + witnessPerInput * input.inputCount) / 4);
}

export function createMultisigAddress(m: number, pubkeys: string[]): MultisigDescriptor {
  const normalized = pubkeys.map(normalizePubkey);
  if (new Set(normalized).size !== normalized.length) {
    fail('duplicate pubkey');
  }
  if (!Number.isInteger(m) || m < 1 || m > normalized.length || normalized.length < 1 || normalized.length > MAX_KEYS) {
    fail('threshold m must be between 1 and the number of pubkeys');
  }
  // BIP67: lexicographic ordering of the raw compressed pubkeys.
  const sorted = normalized
    .map((hex) => Buffer.from(hex, 'hex'))
    .sort((left, right) => left.compare(right));
  const p2ms = bitcoin.payments.p2ms({ m, pubkeys: sorted, network: NETWORK });
  const p2wsh = bitcoin.payments.p2wsh({ redeem: p2ms, network: NETWORK });
  if (!p2ms.output || !p2wsh.address) {
    fail('failed to build the multisig script');
  }
  return {
    m,
    n: sorted.length,
    pubkeys: sorted.map((pubkey) => pubkey.toString('hex')),
    witnessScriptHex: p2ms.output.toString('hex'),
    address: p2wsh.address,
  };
}

export function buildMultisigPsbt(input: {
  witnessScriptHex: string;
  inputs: MultisigSpendInput[];
  outputs: MultisigSpendOutput[];
}): BuiltMultisigPsbt {
  const witnessScript = Buffer.from(String(input.witnessScriptHex || '').trim(), 'hex');
  requireMultisigScript(witnessScript);
  if (!Array.isArray(input.inputs) || input.inputs.length === 0) fail('at least one input is required');
  if (!Array.isArray(input.outputs) || input.outputs.length === 0) fail('at least one output is required');
  const p2wsh = bitcoin.payments.p2wsh({
    redeem: { output: witnessScript, network: NETWORK },
    network: NETWORK,
  });
  if (!p2wsh.output) fail('failed to build the multisig locking script');

  const psbt = new bitcoin.Psbt({ network: NETWORK });
  let inputSum = 0;
  for (const item of input.inputs) {
    const txid = String(item.txid || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) fail('input txid must be 64 hex characters');
    if (!Number.isInteger(item.vout) || item.vout < 0) fail('input vout must be a non-negative integer');
    if (!Number.isInteger(item.value) || item.value <= 0) fail('input value must be a positive number of sats');
    inputSum += item.value;
    psbt.addInput({
      hash: txid,
      index: item.vout,
      witnessUtxo: { script: p2wsh.output, value: item.value },
      witnessScript,
      sighashType: SIGHASH_ALL,
    });
  }
  let outputSum = 0;
  const outputScriptLengths: number[] = [];
  for (const item of input.outputs) {
    // Metalet 1b3f93a: a plain transfer output below 1000 sats is frozen by
    // the inscription-carrier rule, so the recipient could never spend it.
    if (!Number.isInteger(item.value) || !isBtcSpendableSats(item.value)) {
      fail(`output must be at least ${BTC_MIN_SPENDABLE_SATS} sats (inscription-carrier floor)`);
    }
    // Throws for any address that is not on mainnet (network is pinned).
    const outputScript = bitcoin.address.toOutputScript(item.address, NETWORK);
    outputScriptLengths.push(outputScript.length);
    outputSum += item.value;
    psbt.addOutput({ address: item.address, value: item.value });
  }
  if (outputSum >= inputSum) fail('fee must be positive');

  const feeSats = inputSum - outputSum;
  const vsize = estimateMultisigSpendVsize({
    witnessScriptHex: witnessScript.toString('hex'),
    inputCount: input.inputs.length,
    outputScriptLengths,
  });
  const feeRateSatVb = Math.round((feeSats / vsize) * 100) / 100;
  if (feeRateSatVb > MAX_FEE_RATE_SAT_VB) {
    fail(`fee rate ${feeRateSatVb} sat/vB exceeds the ${MAX_FEE_RATE_SAT_VB} sat/vB safety cap (missing change output?)`);
  }
  const warning = feeRateSatVb > WARN_FEE_RATE_SAT_VB
    ? `fee rate ${feeRateSatVb} sat/vB is unusually high; check the change output before signing`
    : undefined;
  return { psbtHex: psbt.toHex(), feeSats, feeRateSatVb, ...(warning ? { warning } : {}) };
}

export function summarizePsbt(psbtHex: string): PsbtSummary {
  const psbt = readPsbt(psbtHex);
  const inputs = psbt.txInputs.map((txIn, index) => {
    const data = psbt.data.inputs[index];
    return {
      txid: txidOf(txIn.hash),
      vout: txIn.index,
      value: data?.witnessUtxo ? data.witnessUtxo.value : null,
      partialSigs: data?.partialSig?.length ?? 0,
      sighashType: inputSighashType(data),
    };
  });
  const outputs = psbt.txOutputs.map((txOut) => ({
    address: txOut.address || addressOf(txOut.script),
    value: txOut.value,
  }));
  const knownValues = inputs.every((item) => item.value != null);
  const feeSats = knownValues
    ? inputs.reduce((sum, item) => sum + (item.value ?? 0), 0) - outputs.reduce((sum, item) => sum + item.value, 0)
    : null;
  return {
    inputCount: inputs.length,
    outputCount: outputs.length,
    feeSats,
    inputs,
    outputs,
  };
}

export function selectMultisigInputIndexes(psbtHex: string, requested?: number[]): number[] {
  const psbt = readPsbt(psbtHex);
  const isMultisigIndex = (index: number) => Boolean(parseMultisigScriptShape(psbt.data.inputs[index]?.witnessScript));
  const witnessValue = (index: number): number | null => {
    const utxo = psbt.data.inputs[index]?.witnessUtxo;
    return utxo ? Number(utxo.value) : null;
  };
  const isSpendableIndex = (index: number) => {
    const value = witnessValue(index);
    // Metalet e266b9c: a <1000 sat input may be an MRC20 / Pin carrier. It is
    // never selected for a plain BTC spend, whatever the caller asked for.
    return isMultisigIndex(index) && value != null && isBtcSpendableSats(value);
  };
  if (!requested || requested.length === 0) {
    return psbt.data.inputs.map((_, index) => index).filter(isSpendableIndex);
  }
  for (const index of requested) {
    if (!Number.isInteger(index) || index < 0 || index >= psbt.data.inputs.length) {
      fail(`input index ${index} is out of range`);
    }
    if (!isMultisigIndex(index)) fail(`input ${index} is not a multisig input`);
    const value = witnessValue(index);
    if (value == null) fail(`input ${index} is missing its witness UTXO`);
    if (!isBtcSpendableSats(value)) {
      fail(`input ${index} carries ${value} sats; UTXOs below ${BTC_MIN_SPENDABLE_SATS} sats may be inscription / MRC20 carriers and are never selected`);
    }
  }
  return requested;
}

export function combinePsbts(psbtHexes: string[]): string {
  if (!Array.isArray(psbtHexes) || psbtHexes.length < 2) fail('at least two PSBTs are required to combine');
  const parsed = psbtHexes.map(readPsbt);
  // bip174's combiner already refuses different unsigned transactions; the
  // sighash check is ours (it never accepts SINGLE/NONE/ANYONECANPAY).
  parsed.forEach(assertSighashAllInputs);
  const [first, ...rest] = parsed;
  return rest.reduce((combined, next) => combined.combine(next), first).toHex();
}

/**
 * finalizeInput requires EXACTLY m signatures for a bare-multisig script
 * ("Too many signatures provided" otherwise). A third signer is normal in the
 * skill's flow, so keep the first m signatures in script-pubkey order and drop
 * the redundant ones — same transaction, same m-of-n witness, no new authority.
 */
function trimExtraSignatures(psbt: bitcoin.Psbt): void {
  psbt.data.inputs.forEach((input, index) => {
    const shape = parseMultisigScriptShape(input.witnessScript);
    if (!shape) return;
    const signatures = input.partialSig ?? [];
    if (signatures.length <= shape.m) return;
    const kept = shape.pubkeys
      .map((pubkey) => signatures.find((entry) => entry.pubkey.equals(pubkey)))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .slice(0, shape.m);
    if (kept.length < shape.m) {
      fail(`input ${index} carries only ${kept.length} usable signatures for a ${shape.m}-of-${shape.n} script`);
    }
    input.partialSig = kept;
  });
}

export function finalizePsbt(psbtHex: string): { rawTx: string; txid: string } {
  const psbt = readPsbt(psbtHex);
  assertSighashAllInputs(psbt);
  trimExtraSignatures(psbt);
  try {
    psbt.finalizeAllInputs();
  } catch (error) {
    fail(`not enough signatures to finalize: ${error instanceof Error ? error.message : String(error)}`);
  }
  let tx: bitcoin.Transaction;
  try {
    // extractTransaction also enforces bitcoinjs' own 5000 sat/vB last-ditch
    // check; keep its message instead of mislabeling it as a signature problem.
    tx = psbt.extractTransaction();
  } catch (error) {
    fail(`finalized transaction was rejected: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { rawTx: tx.toHex(), txid: tx.getId() };
}

export function summarizeRawTx(rawTx: string): RawTxSummary {
  const hex = String(rawTx || '').trim();
  let tx: bitcoin.Transaction;
  try {
    tx = bitcoin.Transaction.fromHex(hex);
  } catch (error) {
    fail(`raw transaction is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    txid: tx.getId(),
    outputs: tx.outs.map((output) => ({
      address: addressOf(output.script),
      value: output.value,
    })),
  };
}
