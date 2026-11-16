import * as bitcoin from 'bitcoinjs-lib';

const NETWORK = bitcoin.networks.bitcoin;
const DUST_SATS = 546;
const MAX_KEYS = 16;
const CHECKMULTISIG = 0xae;
const CHECKMULTISIGVERIFY = 0xaf;

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

export interface PsbtIoSummary {
  txid: string;
  vout: number;
  value: number | null;
  partialSigs: number;
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

function isMultisigWitness(script: Buffer | undefined): script is Buffer {
  return !!script && script.length > 0 && (script[script.length - 1] === CHECKMULTISIG || script[script.length - 1] === CHECKMULTISIGVERIFY);
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

export function createMultisigAddress(m: number, pubkeys: string[]): MultisigDescriptor {
  const normalized = pubkeys.map(normalizePubkey);
  if (new Set(normalized).size !== normalized.length) {
    fail('duplicate pubkey');
  }
  if (!Number.isInteger(m) || m < 1 || m > normalized.length || normalized.length < 1 || normalized.length > MAX_KEYS) {
    fail('threshold m must be between 1 and the number of pubkeys');
  }
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
}): string {
  const witnessScript = Buffer.from(String(input.witnessScriptHex || '').trim(), 'hex');
  if (!isMultisigWitness(witnessScript)) {
    fail('witness script is not a multisig script');
  }
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
      sighashType: bitcoin.Transaction.SIGHASH_ALL,
    });
  }
  let outputSum = 0;
  for (const item of input.outputs) {
    if (!Number.isInteger(item.value) || item.value < DUST_SATS) fail(`output below dust (${DUST_SATS} sats)`);
    bitcoin.address.toOutputScript(item.address, NETWORK);
    outputSum += item.value;
    psbt.addOutput({ address: item.address, value: item.value });
  }
  if (outputSum >= inputSum) fail('fee must be positive');
  return psbt.toHex();
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
  const multisig = psbt.data.inputs
    .map((input, index) => (isMultisigWitness(input.witnessScript) ? index : -1))
    .filter((index) => index >= 0);
  if (!requested || requested.length === 0) return multisig;
  for (const index of requested) {
    if (!Number.isInteger(index) || index < 0 || index >= psbt.data.inputs.length) {
      fail(`input index ${index} is out of range`);
    }
    if (!multisig.includes(index)) fail(`input ${index} is not a multisig input`);
  }
  return requested;
}

export function combinePsbts(psbtHexes: string[]): string {
  if (!Array.isArray(psbtHexes) || psbtHexes.length < 2) fail('at least two PSBTs are required to combine');
  const [first, ...rest] = psbtHexes.map(readPsbt);
  return rest.reduce((combined, next) => combined.combine(next), first).toHex();
}

export function finalizePsbt(psbtHex: string): { rawTx: string; txid: string } {
  const psbt = readPsbt(psbtHex);
  try {
    psbt.finalizeAllInputs();
  } catch (error) {
    fail(`not enough signatures to finalize: ${error instanceof Error ? error.message : String(error)}`);
  }
  const tx = psbt.extractTransaction();
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
