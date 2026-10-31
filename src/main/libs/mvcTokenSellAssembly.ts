/**
 * Offline (network-free, electron-free) MVC assembly builders for the FT
 * TokenSell capability. Imports only meta-contract / mvc-scrypt — given
 * static inputs (cached raw txs, checker cast, signer key) every function
 * here runs fully offline, which is exactly how the offline unit tests
 * exercise the signature wiring.
 *
 * Ported from the live-fire-validated workspace (2026-10-30, evidence dir
 * bots/2/2026-10-30, see docs/token-sell-protocol.md):
 *   - LIST leg: amtcheck/skill-package/sell-list.mjs (stage2b final fix —
 *     tokenTxInputProof = verbatim SDK input0 proof, prevTokenInputIndex=0,
 *     original 112B header; 15-cell EQVERIFY green on the live pair)
 *   - TAKE leg: amtcheck/taker/taker.mjs (op=2 UNLOCK_FROM_CONTRACT,
 *     SIGHASH_SINGLE out1 price binding, OCS short-domain checker preimage,
 *     direct-parent lineage gate)
 */

import { createHash } from 'crypto';
import { mvc } from 'meta-contract';
// dist leaf modules required exactly like the live-fire-validated scripts
// (their .d.ts shapes are unreliable; runtime is what the anchors validated).
// eslint-disable @typescript-eslint/no-var-requires
const scryptlib = require('meta-contract/dist/scryptlib');
const TokenUtil = require('meta-contract/dist/common/tokenUtil');
const { Prevouts } = require('meta-contract/dist/common/Prevouts');
const { TxComposer, sighashType: SIGHASH_ALL_FORKID } = require('meta-contract/dist/tx-composer');
const { TokenFactory } = require('meta-contract/dist/mcp02/contract-factory/token');
const { TokenTransferCheckFactory } = require('meta-contract/dist/mcp02/contract-factory/tokenTransferCheck');
const { TokenUnlockContractCheckFactory } = require('meta-contract/dist/mcp02/contract-factory/tokenUnlockContractCheck');
const utils = require('meta-contract/dist/common/utils');
const protoheader = require('meta-contract/dist/common/protoheader');
const ftProto = require('meta-contract/dist/mcp02/contract-proto/token.proto.js');
const ContractUtil = require('meta-contract/dist/mcp02/contractUtil.js').ContractUtil;
const { DEFAULT_FLAGS: SIG_FLAGS } = require('mvc-scrypt/dist/utils');

export { SIGHASH_ALL_FORKID };
export const SIGHASH_SINGLE_FORKID = 0x43; // protoheader.scrypt:27 + scryptTypes.js:335 (both sides anchored)
export const OP_TRANSFER = 1;
export const OP_UNLOCK_FROM_CONTRACT = 2;
export { DUST_SATS } from './mvcTokenSellCore';
import { assertTokenSellAmountGates, assertTokenTransferAmountGates, decodeTokenSellSeedLock } from './mvcTokenSellCore';

const d256 = (b: Buffer) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest();
const hexB = (b: Buffer | Uint8Array) => Buffer.from(b).toString('hex');

export const BN_SHIM = (v: bigint | number) => ({
  toBuffer: ({ size }: { size: number }) => {
    const b = Buffer.alloc(size);
    b.writeBigUInt64LE(BigInt(v));
    return b;
  },
});

export function p2pkhScript(h160Buf: Buffer): Buffer {
  return Buffer.concat([Buffer.from('76a914', 'hex'), h160Buf, Buffer.from('88ac', 'hex')]);
}

// ---------- preimage plumbing (stage2b/taker lineage) ----------
export function preimageToHex(p: unknown): string {
  if (Buffer.isBuffer(p)) return p.toString('hex');
  const s = String(p);
  if (/^[0-9a-f]+$/i.test(s) && s.length > 100) return s;
  if (p && typeof p === 'object' && 'toHex' in p && typeof (p as { toHex?: () => string }).toHex === 'function') {
    const t = (p as { toHex: () => string }).toHex();
    if (/^[0-9a-f]+$/i.test(t) && t.length > 100) return t;
  }
  throw new Error('unrecognized preimage form');
}

/** chunk-level script re-serialization (probe-ocs5: byte-identical to toBuffer). */
export function serializeScriptChunks(chunks: Array<{ opcodenum: number; buf?: Buffer | null }>): Buffer {
  const parts: Buffer[] = [];
  for (const c of chunks) {
    if (c.buf === undefined || c.buf === null) {
      parts.push(Buffer.from([c.opcodenum & 0xff]));
      continue;
    }
    const buf = Buffer.from(c.buf);
    if (c.opcodenum <= 0x4b) parts.push(Buffer.from([c.opcodenum]), buf);
    else if (c.opcodenum === 0x4c) parts.push(Buffer.from([0x4c, buf.length]), buf);
    else if (c.opcodenum === 0x4d) parts.push(Buffer.from([0x4d, buf.length & 0xff, (buf.length >> 8) & 0xff]), buf);
    else if (c.opcodenum === 0x4e)
      parts.push(
        Buffer.from([0x4e, buf.length & 0xff, (buf.length >> 8) & 0xff, (buf.length >> 16) & 0xff, (buf.length >> 24) & 0xff]),
        buf,
      );
    else parts.push(Buffer.from([c.opcodenum & 0xff]));
  }
  return Buffer.concat(parts);
}

/**
 * OCS short-domain preimage (stage2b 4th-rod fix, live-validated):
 * TransferCheck-family checkers require the preimage computed over the script
 * tail AFTER the last OP_CODESEPARATOR; the trailing CHECKSIG operands are
 * assembled on-stack from the contract's own dataPart constants.
 */
export function buildOcsCheckPreimage(
  tc: any,
  inputIdx: number,
  checkerScriptBuf: Buffer,
  checkerSat: bigint | number,
): string {
  const lockScript = mvc.Script.fromBuffer(checkerScriptBuf);
  let pbc = 0;
  lockScript.chunks.forEach((c: { opcodenum: number }, i: number) => {
    if (c.opcodenum === 0xab) pbc = i + 1; // 0xab = OP_CODESEPARATOR
  });
  if (!pbc) throw new Error('checker lock script has no OP_CODESEPARATOR');
  const tailScript = mvc.Script.fromBuffer(serializeScriptChunks(lockScript.chunks.slice(pbc)));
  return preimageToHex(
    mvc.Transaction.Sighash.sighashPreimage(
      tc.getTx(),
      SIGHASH_ALL_FORKID,
      inputIdx,
      tailScript,
      new mvc.crypto.BN(Number(checkerSat)),
      SIG_FLAGS,
    ),
  );
}

// ---------- deterministic fee + consensus txid (stage2b/taker conventions) ----------
/** 70..73B pushes counted at 73B → dry-run and real signatures converge to one structure. */
export function sigNormalizedScriptLen(buf: Buffer): number {
  let total = 0;
  let i = 0;
  while (i < buf.length) {
    const op = buf[i];
    if (op >= 0x01 && op <= 0x4b) {
      const n = op;
      total += n >= 70 && n <= 73 ? 1 + 73 : 1 + n;
      i += 1 + n;
    } else if (op === 0x00) {
      total += 1;
      i += 1;
    } else if (op === 0x4c || op === 0x4d || op === 0x4e) {
      const lb = op === 0x4c ? 1 : op === 0x4d ? 2 : 4;
      const n = buf.readUIntLE(i + 1, lb);
      total += 1 + lb + n;
      i += 1 + lb + n;
    } else {
      total += 1;
      i += 1;
    }
  }
  return total;
}

export function estimateTxLenMax(tc: any): number {
  const tx = tc.getTx();
  let est = tx.toBuffer().length;
  for (const inp of tx.inputs) {
    const sb = inp.script.toBuffer();
    est += sigNormalizedScriptLen(sb) - sb.length;
  }
  return est;
}

// txid convention (taker.mjs header verdict, live-verified against f518099d):
// MVC consensus txid COMMITS to scriptSigs via the v10 header's scriptRoot —
// mvc-lib Transaction.id IS the consensus/broadcast txid. Never strip
// scriptSigs for a listing reference.
export function consensusTxId(tc: any): string {
  return tc.getTx().id;
}

// ---------- verify classification (stage2b object-form fix) ----------
export type VerifyClass = 'PASS' | 'CHECKSIG_FAMILY' | 'FAIL';
export interface VerifyVerdict {
  cls: VerifyClass | 'THROW';
  detail: string;
}

export function classifyVerify(v: unknown): VerifyVerdict {
  if (v === true) return { cls: 'PASS', detail: 'true' };
  if (v && typeof v === 'object' && (v as { success?: boolean }).success === true) {
    return { cls: 'PASS', detail: 'object{success:true}' };
  }
  const msg = typeof v === 'string' ? v : (v && ((v as { error?: string }).error || (v as { message?: string }).message)) || JSON.stringify(v);
  const cls: VerifyClass = /CHECKSIG|NULLFAIL|EVAL_FALSE/i.test(msg) ? 'CHECKSIG_FAMILY' : 'FAIL';
  return { cls, detail: msg };
}

/** Bare interpreter over the DEPLOYED lock bytes (desc-template run_verify is a lossy approximation). */
export function runBareInterpreter(
  unlockScriptBuf: Buffer,
  lockScriptBuf: Buffer,
  tx: mvc.Transaction,
  inputIdx: number,
  satoshis: bigint | number,
): VerifyVerdict {
  mvc.Script.Interpreter.MAX_SCRIPT_ELEMENT_SIZE = Number.MAX_SAFE_INTEGER;
  mvc.Script.Interpreter.MAXIMUM_ELEMENT_SIZE = Number.MAX_SAFE_INTEGER;
  const iv = (mvc.Script.Interpreter as any)();
  const ok = (iv as any).verify(
    mvc.Script.fromBuffer(unlockScriptBuf),
    mvc.Script.fromBuffer(lockScriptBuf),
    tx,
    inputIdx,
    SIG_FLAGS,
    new mvc.crypto.BN(Number(satoshis)),
  );
  if (ok) return classifyVerify(true);
  const err = (iv as any).errstr || 'unknown';
  return /CHECKSIG|NULLFAIL|EVAL_FALSE/i.test(err)
    ? { cls: 'CHECKSIG_FAMILY', detail: 'VerifyError: ' + err }
    : { cls: 'FAIL', detail: err };
}

// ---------- signer ----------
export interface TokenSellSigner {
  mode: 'real' | 'dry';
  privKey: mvc.PrivateKey;
  pubHex: string;
  h160Hex: string;
  address: string;
  debug?: boolean;
}

function privToWif(priv: Buffer): string {
  const payload = Buffer.concat([Buffer.from([0x80]), priv, Buffer.from([0x01])]);
  const ck = d256(payload).subarray(0, 4);
  const full = Buffer.concat([payload, ck]);
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + full.toString('hex'));
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of full) {
    if (b === 0) out = '1' + out;
    else break;
  }
  return out;
}

/** Deterministic dry key (never persisted, never echoed); same shape as the validated scripts. */
export function makeDryTokenSellKeypair(label: string): { privKey: mvc.PrivateKey; pubHex: string; h160Hex: string; address: string } {
  const priv = createHash('sha256').update(`idbots-token-sell-dryrun-v1|${label}`).digest();
  const privKey = new mvc.PrivateKey(privToWif(priv));
  const pub = Buffer.from(privKey.publicKey.toString(), 'hex');
  return {
    privKey,
    pubHex: pub.toString('hex'),
    h160Hex: mvc.crypto.Hash.sha256ripemd160(pub).toString('hex'),
    address: privKey.toAddress('livenet').toString(),
  };
}

export function signerFromWif(wif: string, mode: 'real' | 'dry'): TokenSellSigner {
  const privKey = mvc.PrivateKey.fromWIF(wif.trim());
  const pub = Buffer.from(privKey.publicKey.toString(), 'hex');
  return {
    mode,
    privKey,
    pubHex: pub.toString('hex'),
    h160Hex: mvc.crypto.Hash.sha256ripemd160(pub).toString('hex'),
    address: privKey.toAddress('livenet').toString(),
  };
}

// ---------- token helpers ----------
function newTokenContract(): any {
  return TokenFactory.createContract(
    ContractUtil.transferCheckCodeHashArray,
    ContractUtil.unlockContractCodeHashArray,
    2, // SDK default version=2; both desc generations share the 18-param ABI
  );
}

export function tokenCodePartBuf(): Buffer {
  ContractUtil.init();
  return newTokenContract().lockingScript.toBuffer();
}


export function parseTokenDataPart(scriptBuf: Buffer): { tokenAddress: string; tokenAmount: string } & Record<string, unknown> {
  return ftProto.parseDataPart(scriptBuf) as { tokenAddress: string; tokenAmount: string } & Record<string, unknown>;
}

export function getNewTokenScript(tokenScriptBuf: Buffer, toHash160: Buffer, amount: bigint | number): Buffer {
  return Buffer.from(ftProto.getNewTokenScript(tokenScriptBuf, toHash160, BN_SHIM(amount)));
}

export function getTokenCodeHashHex(scriptBuf: Buffer): string {
  return hexB(ftProto.getContractCodeHash(scriptBuf));
}

export function getTokenIdHex(scriptBuf: Buffer): string {
  return hexB(ftProto.getTokenID(scriptBuf));
}

// ---------- checker casts ----------
export interface CheckerCast {
  scriptBuf: Buffer;
  sats: bigint;
  type: number;
  txid: string;
  vout: number;
  txHex: string;
  dataPartObj?: Record<string, unknown>;
}

/**
 * op=1 family checker (TokenTransferCheck) for the LIST leg — receiver is the
 * SEED LOCK's hash160 and the amount is the LISTED amount (conservation
 * pairing; stage1 live cast shape, consumed by the live listing e281d9a2…).
 */
export function buildTransferCheckLock(input: {
  type: number;
  tokenCodeHashHex: string;
  tokenIdHex: string;
  receiverHash160Buf: Buffer;
  tokenAmount: bigint;
}): Buffer {
  const check = (TokenTransferCheckFactory as any).createContract(input.type);
  check.setFormatedDataPart({
    nSenders: 1,
    receiverTokenAmountArray: [
      {
        toBuffer: (o?: { endian?: string }) => {
          const b = Buffer.alloc(8);
          b.writeBigUInt64LE(BigInt(input.tokenAmount));
          return o && o.endian === 'little' ? b : b.reverse();
        },
      },
    ],
    receiverArray: [{ hashBuffer: input.receiverHash160Buf }],
    nReceivers: 1,
    tokenCodeHash: input.tokenCodeHashHex,
    tokenID: input.tokenIdHex,
  });
  return check.lockingScript.toBuffer();
}

/**
 * op=2 family checker (TokenUnlockContractCheck, the SDK _burn family) for
 * the TAKE leg — receiver is the taker's own address.
 */
export function buildUnlockCheckLock(input: {
  type: number;
  tokenCodeHashHex: string;
  tokenIdHex: string;
  receiverHash160Buf: Buffer;
  tokenAmount: bigint;
}): { lockBuf: Buffer; dataPartObj: Record<string, unknown> } {
  const check = (TokenUnlockContractCheckFactory as any).createContract(input.type);
  const dataPartObj = {
    nSenders: 1,
    senderInputIndexArray: [0],
    receiverTokenAmountArray: [BN_SHIM(input.tokenAmount)],
    receiverArray: [{ hashBuffer: input.receiverHash160Buf }],
    nReceivers: 1,
    tokenCodeHash: input.tokenCodeHashHex,
    tokenID: input.tokenIdHex,
  };
  check.setFormatedDataPart(dataPartObj);
  return { lockBuf: check.lockingScript.toBuffer(), dataPartObj };
}

export function getOptimumCheckerType(nIn: number, nOut: number): number {
  return (TokenTransferCheckFactory as any).getOptimumType(nIn, nOut);
}

// ---------- simple P2PKH funding tx (seed / checker mint), deterministic fee ----------
function convergeFee(
  fundingSats: bigint,
  fixedOutSat: bigint,
  buildRound: (change: bigint) => { tc: any; hasChange: boolean },
): { tc: any; fee: bigint } {
  let change = fundingSats - fixedOutSat - 250n;
  let built: { tc: any; hasChange: boolean } | null = null;
  for (let i = 0; i < 6; i++) {
    built = buildRound(change);
    const feeTarget = BigInt(Math.ceil(estimateTxLenMax(built.tc)));
    const spent = fundingSats - fixedOutSat - (built.hasChange ? change : 0n);
    if (spent >= feeTarget && spent - feeTarget < 3n) return { tc: built.tc, fee: spent };
    change = fundingSats - fixedOutSat - feeTarget;
    if (change > 0n && change < 600n) change = 0n;
  }
  if (!built) throw new Error('fee convergence produced nothing');
  return { tc: built.tc, fee: fundingSats - fixedOutSat - (built.hasChange ? change : 0n) };
}

export interface SimpleFundingUtxo {
  txid: string;
  vout: number;
  sats: bigint;
}

/** TxA: funding P2PKH → out0 = TokenSell seed lock, out1 = change (required: TxB spends it). */
export function buildSeedTx(input: {
  seedLock: Buffer;
  seedSats: bigint;
  funding: SimpleFundingUtxo;
  signer: TokenSellSigner;
}): { tc: any; seedIdx: number; changeIdx: number; txHex: string; txid: string; fee: bigint } {
  const { seedLock, seedSats, funding, signer } = input;
  const h160 = Buffer.from(signer.h160Hex, 'hex');
  const { tc, fee } = convergeFee(funding.sats, seedSats, (change) => {
    const t = new TxComposer(new mvc.Transaction());
    const inIdx = t.appendInput({
      txId: funding.txid,
      outputIndex: funding.vout,
      satoshis: Number(funding.sats),
      lockingScript: new mvc.Script(p2pkhScript(h160)),
    });
    t.appendOutput({ lockingScript: new mvc.Script(seedLock), satoshis: Number(seedSats) });
    if (change > 0n) t.appendOutput({ lockingScript: new mvc.Script(p2pkhScript(h160)), satoshis: Number(change) });
    t.unlockP2PKHInput(signer.privKey, inIdx, SIGHASH_ALL_FORKID);
    return { tc: t, hasChange: change > 0n };
  });
  const outputs = tc.getTx().outputs;
  let seedIdx = -1;
  let changeIdx = -1;
  outputs.forEach((o: mvc.Transaction.Output, n: number) => {
    const b = o.script.toBuffer();
    if (b.equals(seedLock)) seedIdx = n;
    else if (b.length === 25 && b[0] === 0x76) changeIdx = n;
  });
  if (seedIdx < 0 || changeIdx < 0) throw new Error('seed tx must carry a seed output and a P2PKH change output');
  return { tc, seedIdx, changeIdx, txHex: tc.getRawHex(), txid: consensusTxId(tc), fee };
}

/** TxC: funding P2PKH → out0 = checker lock, out1 = change. */
export function buildCheckerMintTx(input: {
  checkerLock: Buffer;
  checkerSats: bigint;
  funding: SimpleFundingUtxo;
  signer: TokenSellSigner;
}): { tc: any; outIdx: number; txHex: string; txid: string } {
  const { checkerLock, checkerSats, funding, signer } = input;
  const h160 = Buffer.from(signer.h160Hex, 'hex');
  const { tc } = convergeFee(funding.sats, checkerSats, (change) => {
    const t = new TxComposer(new mvc.Transaction());
    const inIdx = t.appendInput({
      txId: funding.txid,
      outputIndex: funding.vout,
      satoshis: Number(funding.sats),
      lockingScript: new mvc.Script(p2pkhScript(h160)),
    });
    t.appendOutput({ lockingScript: new mvc.Script(checkerLock), satoshis: Number(checkerSats) });
    if (change > 0n) t.appendOutput({ lockingScript: new mvc.Script(p2pkhScript(h160)), satoshis: Number(change) });
    t.unlockP2PKHInput(signer.privKey, inIdx, SIGHASH_ALL_FORKID);
    return { tc: t, hasChange: change > 0n };
  });
  return { tc, outIdx: 0, txHex: tc.getRawHex(), txid: consensusTxId(tc) };
}

const fieldHex = (v: unknown): string => {
  if (typeof v === 'string') return v;
  const obj = v as { serialize?: () => string; toHex?: () => string };
  if (obj && typeof obj.serialize === 'function') return obj.serialize();
  if (obj && typeof obj.toHex === 'function') return obj.toHex();
  return String(v);
};

/** Field-wise TxInputProof rebuild (stage2b final form — the direct object wrap
 * is not portable across mvc-scrypt patch levels). */
function rebuildTxInputProof(ProofClasses: any, fields: any): any {
  return new ProofClasses.TxInputProof({
    hashProof: new scryptlib.Bytes(fieldHex(fields.hashProof)),
    txHash: new scryptlib.Bytes(fieldHex(fields.txHash)),
    outputIndexBytes: new scryptlib.Bytes(fieldHex(fields.outputIndexBytes)),
    sequenceBytes: new scryptlib.Bytes(fieldHex(fields.sequenceBytes)),
  });
}

// ---------- LIST (TxB) assembly ----------
export interface ListTxBStaticInputs {
  tokenTxHex: string; // raw tx carrying the token utxo being listed
  tokenVout: number;
  tokenTxid: string; // consensus id of tokenTxHex (fail-fast cross-check)
  prevTokenTxHex: string; // direct parent of the token leg (lineage)
  prevTokenInputIndex: number; // token's input slot inside tokenTx (default 0)
  tokenAmount: bigint; // full dataPart amount of the utxo (gates already applied)
  checker: CheckerCast; // op=1 family cast, receiver = seed lock hash160, amount = tokenAmount
  txaTxid: string;
  txaChangeIdx: number;
  txaChangeSat: bigint;
  seedLock: Buffer;
  sellerSigner: TokenSellSigner;
  /** sat/byte fee floor; the live-fire legs converged at 1 (deterministic estimate). */
  feeRate?: number;
  /**
   * stage2b dry-run posture: sign with an unreachable dry key while pushing
   * the TRUE seller pubkey / change hash160 (recovered from public chain
   * data) so the sender-authorization and change EQ cells stay green and the
   * only unprovable cell is the CHECKSIG family. The real path (session bot
   * == seller) never sets this.
   */
  dryRunOverrides?: { senderPubKeyHex: string; changeH160Hex: string };
}

export interface ListTxBResult {
  tc: any;
  txHex: string;
  txid: string;
  fee: bigint;
  size: number;
  rounds: number;
  inSatSum: bigint;
  tokenSats: bigint;
  tokenOutScript: Buffer;
  seedAddrH: Buffer;
  outIdx: { token: number; change: number };
  prev: { prevTokenAddress: string; prevTokenAmount: bigint; prevVout: number };
  verdicts: { token: VerifyVerdict; checker: VerifyVerdict };
}

/**
 * TxB listing assembly: in0 = token utxo (op=1 TRANSFER), in1 = checker
 * (TransferCheck OCS leg), in2 = TxA change (P2PKH) → out0 = token locked to
 * hash160(sha256(seedLock)), out1 = seller change. Byte-shape identical to
 * the live listing e281d9a2… (stage2b final: verbatim SDK input0 proof).
 */
export function buildListTxB(S: ListTxBStaticInputs): ListTxBResult {
  const tokenTx = new mvc.Transaction(S.tokenTxHex);
  if (tokenTx.id !== S.tokenTxid) throw new Error(`token raw consensus id ${tokenTx.id} != ${S.tokenTxid}`);
  const tokenScriptBuf = tokenTx.outputs[S.tokenVout].script.toBuffer();
  const tokenSats = BigInt(tokenTx.outputs[S.tokenVout].satoshis);
  const dp = parseTokenDataPart(tokenScriptBuf);
  // CONSTRUCTION-PATH HARD GATE (offline-enforceable): the listing must
  // consume the token utxo IN FULL — partial quantities break the checker
  // conservation. Price is decoded from the seed lock, not trusted input.
  const utxoTokenAmount = BigInt(String(dp.tokenAmount));
  const decodedSeed = decodeTokenSellSeedLock(S.seedLock, require('meta-contract/dist/mcp02/contract-desc/tokenSell_desc.json'));
  assertTokenSellAmountGates({
    priceSats: decodedSeed.priceSats,
    listedTokenAmount: S.tokenAmount,
    utxoTokenAmount,
  });

  const prevTokenTx = new mvc.Transaction(S.prevTokenTxHex);
  const prevVout = tokenTx.inputs[S.prevTokenInputIndex].outputIndex;
  const prevDp = parseTokenDataPart(prevTokenTx.outputs[prevVout].script.toBuffer());
  const prevTokenAddress = Buffer.from(prevDp.tokenAddress as string, 'hex').toString('hex');
  const prevTokenAmount = BigInt(String(prevDp.tokenAmount));
  // Lineage input proof — VERBATIM SDK bytes (stage2b final verdict: any
  // self-anchored rewrite breaks the deployment-generation consistency).
  const inputRes = TokenUtil.getTxInputProof(tokenTx, S.prevTokenInputIndex);
  const ProofClasses = scryptlib.buildTypeClasses(
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('meta-contract/dist/mcp02/contract-desc/txUtil_desc.json'),
  );
  const tokenTxInputProof = rebuildTxInputProof(ProofClasses, inputRes[0]);
  const tokenTxHeader = inputRes[1];
  const prevTokenTxOutputProof = new ProofClasses.TxOutputProof(TokenUtil.getTxOutputProof(prevTokenTx, prevVout));

  const seedAddrH = mvc.crypto.Hash.sha256ripemd160(S.seedLock); // op=2 redeemable slot
  const tokenOutScript = getNewTokenScript(tokenScriptBuf, seedAddrH, S.tokenAmount);
  const senderPubKeyHex = S.dryRunOverrides?.senderPubKeyHex ?? S.sellerSigner.pubHex;
  const sellerH160 = Buffer.from(S.dryRunOverrides?.changeH160Hex ?? S.sellerSigner.h160Hex, 'hex');

  const inSatSum = tokenSats + S.checker.sats + S.txaChangeSat;
  const fixedOut = tokenSats;
  const feeRate = Number(S.feeRate) > 0 ? Number(S.feeRate) : 1;
  let changeSat = inSatSum - fixedOut - 15000n;
  let built: { tc: any; tokenIdx: number; chkIdx: number; fundIdx: number; tokenOutIdx: number; changeIdx: number } | null = null;
  let wired: { tokenCall: ReturnType<InstanceType<typeof TokenFactory>['unlock']>; checkCall: unknown; verdicts: { token: VerifyVerdict; checker: VerifyVerdict } } | null = null;
  let rounds = 0;
  let finalFee = 0n;
  for (let round = 0; round < 8; round++) {
    rounds = round + 1;
    const tc = new TxComposer(new mvc.Transaction());
    const tokenIdx = tc.appendInput({ txId: S.tokenTxid, outputIndex: S.tokenVout, satoshis: Number(tokenSats), lockingScript: new mvc.Script(tokenScriptBuf) });
    if (tokenIdx !== 0) throw new Error('token leg must be input index 0');
    const chkIdx = tc.appendInput({ txId: S.checker.txid, outputIndex: S.checker.vout, satoshis: Number(S.checker.sats), lockingScript: new mvc.Script(S.checker.scriptBuf) });
    const fundIdx = tc.appendInput({ txId: S.txaTxid, outputIndex: S.txaChangeIdx, satoshis: Number(S.txaChangeSat), lockingScript: new mvc.Script(p2pkhScript(sellerH160)) });
    const tokenOutIdx = tc.appendOutput({ lockingScript: new mvc.Script(tokenOutScript), satoshis: Number(tokenSats) });
    let changeIdx = -1;
    if (changeSat > 0n) changeIdx = tc.appendOutput({ lockingScript: new mvc.Script(p2pkhScript(sellerH160)), satoshis: Number(changeSat) });
    built = { tc, tokenIdx, chkIdx, fundIdx, tokenOutIdx, changeIdx };

    const prevouts = new Prevouts();
    prevouts.addVout(S.tokenTxid, S.tokenVout);
    prevouts.addVout(S.checker.txid, S.checker.vout);
    prevouts.addVout(S.txaTxid, S.txaChangeIdx);

    // token leg: op=1 TRANSFER, 18-param unlock (live e281d9a2 shape)
    const tokenInst = newTokenContract();
    tokenInst.setFormatedDataPart(dp as any);
    const preimageHex = preimageToHex(tc.getInputPreimage(tokenIdx, SIGHASH_ALL_FORKID));
    const sigRaw = tc.getTxFormatSig(S.sellerSigner.privKey, tokenIdx, SIGHASH_ALL_FORKID);
    const senderSig = typeof sigRaw === 'string' ? sigRaw : scryptlib.toHex(sigRaw);
    const checkerProof = new ProofClasses.TxOutputProof(TokenUtil.getTxOutputProof(new mvc.Transaction(S.checker.txHex), S.checker.vout));
    const tokenCall = tokenInst.unlock({
      txPreimage: new scryptlib.SigHashPreimage(preimageHex),
      prevouts: new scryptlib.Bytes(prevouts.toHex()),
      tokenInputIndex: tokenIdx,
      amountCheckHashIndex: S.checker.type - 1,
      amountCheckInputIndex: chkIdx,
      amountCheckTxOutputProofInfo: checkerProof,
      amountCheckScript: new scryptlib.Bytes(hexB(S.checker.scriptBuf)),
      prevTokenInputIndex: S.prevTokenInputIndex,
      prevTokenAddress: new scryptlib.Bytes(prevTokenAddress),
      prevTokenAmount,
      tokenTxHeader,
      tokenTxInputProof,
      prevTokenTxOutputProof,
      senderPubKey: new scryptlib.PubKey(senderPubKeyHex),
      senderSig: new scryptlib.Sig(senderSig),
      contractInputIndex: 0,
      contractTxOutputProof: new ProofClasses.TxOutputProof(TokenUtil.getEmptyTxOutputProof()),
      operation: OP_TRANSFER,
    });
    tc.getInput(tokenIdx).setScript(tokenCall.toScript());

    // checker leg: TransferCheck op=1 family, OCS short-domain preimage
    const checkInst = TokenTransferCheckFactory.createContract(S.checker.type);
    if (S.checker.dataPartObj) (checkInst as any).setFormatedDataPart(S.checker.dataPartObj);
    const tokProof = TokenUtil.getTxOutputProof(tokenTx, S.tokenVout);
    const checkPreimage = buildOcsCheckPreimage(tc, chkIdx, S.checker.scriptBuf, S.checker.sats);
    const checkCall = checkInst.unlock({
      txPreimage: new scryptlib.SigHashPreimage(checkPreimage),
      prevouts: new scryptlib.Bytes(prevouts.toHex()),
      tokenScript: new scryptlib.Bytes(hexB(tokenScriptBuf)),
      tokenTxHeaderArray: new scryptlib.Bytes(hexB(Buffer.from(tokProof.txHeader.serialize(), 'hex'))),
      tokenTxHashProofArray: new scryptlib.Bytes(
        hexB(Buffer.concat([TokenUtil.getUInt32Buf(Buffer.from(tokProof.hashProof.serialize(), 'hex').length), Buffer.from(tokProof.hashProof.serialize(), 'hex')])),
      ),
      tokenSatoshiBytesArray: new scryptlib.Bytes(hexB(Buffer.from(tokProof.satoshiBytes.serialize(), 'hex'))),
      inputTokenAddressArray: new scryptlib.Bytes(hexB(Buffer.from(dp.tokenAddress as string, 'hex'))),
      inputTokenAmountArray: new scryptlib.Bytes(
        hexB(
          (() => {
            const b = Buffer.alloc(8);
            b.writeBigUInt64LE(S.tokenAmount);
            return b;
          })(),
        ),
      ),
      tokenOutputSatoshis: Number(tokenSats),
      changeSatoshis: Number(changeSat),
      changeAddress: new scryptlib.Ripemd160(senderPubKeyHex && S.dryRunOverrides?.changeH160Hex ? S.dryRunOverrides.changeH160Hex : S.sellerSigner.h160Hex),
      opReturnScript: new scryptlib.Bytes(''),
    });
    tc.getInput(chkIdx).setScript(checkCall.toScript());

    // funding leg: TxA change P2PKH
    tc.unlockP2PKHInput(S.sellerSigner.privKey, fundIdx, SIGHASH_ALL_FORKID);

    // deterministic fee convergence
    const feeTarget = BigInt(Math.ceil(estimateTxLenMax(tc) * feeRate));
    const spentFee = inSatSum - fixedOut - changeSat;
    const verdicts = {
      token: classifyVerify(tokenCall.verify({ tx: tc.getTx(), inputIndex: tokenIdx, inputSatoshis: Number(tokenSats) })),
      checker: runBareInterpreter(tc.getInput(chkIdx).script.toBuffer(), S.checker.scriptBuf, tc.getTx(), chkIdx, S.checker.sats),
    };
    wired = { tokenCall, checkCall, verdicts };
    if (spentFee >= feeTarget && spentFee - feeTarget < 3n) {
      finalFee = spentFee;
      break;
    }
    changeSat = inSatSum - fixedOut - feeTarget;
    if (changeSat > 0n && changeSat < 600n) changeSat = 0n;
  }
  if (!built || !wired) throw new Error('LIST fee loop not converged');
  return {
    tc: built.tc,
    txHex: built.tc.getTx().serialize(true),
    txid: consensusTxId(built.tc),
    fee: finalFee,
    size: built.tc.getTx().toBuffer().length,
    rounds,
    inSatSum,
    tokenSats,
    tokenOutScript,
    seedAddrH,
    outIdx: { token: built.tokenOutIdx, change: built.changeIdx },
    prev: { prevTokenAddress, prevTokenAmount, prevVout },
    verdicts: wired.verdicts,
  };
}

// ---------- TRANSFER (op=1, non-trade full-utxo move) assembly ----------
export interface TransferTxBStaticInputs {
  tokenTxHex: string; // raw tx carrying the token utxo being transferred
  tokenVout: number;
  tokenTxid: string; // consensus id of tokenTxHex (fail-fast cross-check)
  prevTokenTxHex: string; // direct parent of the token leg (lineage)
  prevTokenInputIndex: number; // token's input slot inside tokenTx (default 0)
  tokenAmount: bigint; // full dataPart amount of the utxo (gates already applied)
  receiverH160Buf: Buffer; // raw MVC receiver address hash160
  checker: CheckerCast; // op=1 family cast, receiver = receiverH160Buf, amount = tokenAmount
  funding: SimpleFundingUtxo; // session bot P2PKH utxo paying fees
  signer: TokenSellSigner;
  /** sat/byte fee floor; the live-fire legs converged at 1 (deterministic estimate). */
  feeRate?: number;
  /**
   * Dry-run posture (tests only): sign with an unreachable dry key while
   * pushing the TRUE sender pubkey / change hash160 recovered from public
   * chain data, so only the CHECKSIG-family cell can be unprovable offline.
   * The real path (session bot == token owner) never sets this.
   */
  dryRunOverrides?: { senderPubKeyHex: string; changeH160Hex: string };
}

export interface TransferTxBResult {
  tc: any;
  txHex: string;
  txid: string;
  fee: bigint;
  size: number;
  rounds: number;
  inSatSum: bigint;
  tokenSats: bigint;
  tokenOutScript: Buffer;
  receiverH160Hex: string;
  outIdx: { token: number; change: number };
  prev: { prevTokenAddress: string; prevTokenAmount: bigint; prevVout: number };
  verdicts: { token: VerifyVerdict; checker: VerifyVerdict };
}

/**
 * Non-trade op=1 TRANSFER assembly (wallet_token_transfer): the TokenSell
 * LIST shape trimmed of its trade coupling —
 *   in0 = token utxo (op=1 TRANSFER, 18-param unlock, verbatim SDK input0
 *        proof + backtrace lineage, same as LIST),
 *   in1 = checker (TransferCheck op=1 family, OCS leg; receiver = the RAW
 *        receiver hash160 — conservation pairs with the full utxo amount),
 *   in2 = session funding P2PKH (fees)
 *   → out0 = token locked to the receiver (taker.mjs out0 shape:
 *        getNewTokenScript(token, receiverH160, fullAmount)), out1 = change.
 * No seed lock, no price output, no listing tuple — this is a plain move.
 */
export function buildTransferTxB(S: TransferTxBStaticInputs): TransferTxBResult {
  const tokenTx = new mvc.Transaction(S.tokenTxHex);
  if (tokenTx.id !== S.tokenTxid) throw new Error(`token raw consensus id ${tokenTx.id} != ${S.tokenTxid}`);
  const tokenScriptBuf = tokenTx.outputs[S.tokenVout].script.toBuffer();
  const tokenSats = BigInt(tokenTx.outputs[S.tokenVout].satoshis);
  const dp = parseTokenDataPart(tokenScriptBuf);
  // CONSTRUCTION-PATH HARD GATE (offline-enforceable): a TRANSFER moves the
  // token utxo IN FULL — the checker conservation pairs the TransferCheck
  // receiver amount with the token output amount.
  const utxoTokenAmount = BigInt(String(dp.tokenAmount));
  assertTokenTransferAmountGates({
    transferTokenAmount: S.tokenAmount,
    utxoTokenAmount,
    checkerSats: S.checker.sats,
  });

  const prevTokenTx = new mvc.Transaction(S.prevTokenTxHex);
  const prevVout = tokenTx.inputs[S.prevTokenInputIndex].outputIndex;
  const prevDp = parseTokenDataPart(prevTokenTx.outputs[prevVout].script.toBuffer());
  const prevTokenAddress = Buffer.from(prevDp.tokenAddress as string, 'hex').toString('hex');
  const prevTokenAmount = BigInt(String(prevDp.tokenAmount));
  // Lineage input proof — VERBATIM SDK bytes (same stage2b verdict as LIST).
  const inputRes = TokenUtil.getTxInputProof(tokenTx, S.prevTokenInputIndex);
  const ProofClasses = scryptlib.buildTypeClasses(
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('meta-contract/dist/mcp02/contract-desc/txUtil_desc.json'),
  );
  const tokenTxInputProof = rebuildTxInputProof(ProofClasses, inputRes[0]);
  const tokenTxHeader = inputRes[1];
  const prevTokenTxOutputProof = new ProofClasses.TxOutputProof(TokenUtil.getTxOutputProof(prevTokenTx, prevVout));

  const receiverH160 = Buffer.from(S.receiverH160Buf);
  if (receiverH160.length !== 20) throw new Error('receiver hash160 must be 20 bytes');
  const tokenOutScript = getNewTokenScript(tokenScriptBuf, receiverH160, S.tokenAmount);
  const senderPubKeyHex = S.dryRunOverrides?.senderPubKeyHex ?? S.signer.pubHex;
  const senderH160 = Buffer.from(S.dryRunOverrides?.changeH160Hex ?? S.signer.h160Hex, 'hex');

  const inSatSum = tokenSats + S.checker.sats + S.funding.sats;
  const fixedOut = tokenSats;
  const feeRate = Number(S.feeRate) > 0 ? Number(S.feeRate) : 1;
  let changeSat = inSatSum - fixedOut - 15000n;
  let built: { tc: any; tokenIdx: number; chkIdx: number; fundIdx: number; tokenOutIdx: number; changeIdx: number } | null = null;
  let wired: { tokenCall: ReturnType<InstanceType<typeof TokenFactory>['unlock']>; checkCall: unknown; verdicts: { token: VerifyVerdict; checker: VerifyVerdict } } | null = null;
  let rounds = 0;
  let finalFee = 0n;
  for (let round = 0; round < 8; round++) {
    rounds = round + 1;
    const tc = new TxComposer(new mvc.Transaction());
    const tokenIdx = tc.appendInput({ txId: S.tokenTxid, outputIndex: S.tokenVout, satoshis: Number(tokenSats), lockingScript: new mvc.Script(tokenScriptBuf) });
    if (tokenIdx !== 0) throw new Error('token leg must be input index 0');
    const chkIdx = tc.appendInput({ txId: S.checker.txid, outputIndex: S.checker.vout, satoshis: Number(S.checker.sats), lockingScript: new mvc.Script(S.checker.scriptBuf) });
    const fundIdx = tc.appendInput({ txId: S.funding.txid, outputIndex: S.funding.vout, satoshis: Number(S.funding.sats), lockingScript: new mvc.Script(p2pkhScript(senderH160)) });
    const tokenOutIdx = tc.appendOutput({ lockingScript: new mvc.Script(tokenOutScript), satoshis: Number(tokenSats) });
    let changeIdx = -1;
    if (changeSat > 0n) changeIdx = tc.appendOutput({ lockingScript: new mvc.Script(p2pkhScript(senderH160)), satoshis: Number(changeSat) });
    built = { tc, tokenIdx, chkIdx, fundIdx, tokenOutIdx, changeIdx };

    const prevouts = new Prevouts();
    prevouts.addVout(S.tokenTxid, S.tokenVout);
    prevouts.addVout(S.checker.txid, S.checker.vout);
    prevouts.addVout(S.funding.txid, S.funding.vout);

    // token leg: op=1 TRANSFER, 18-param unlock (same live ABI as LIST)
    const tokenInst = newTokenContract();
    tokenInst.setFormatedDataPart(dp as any);
    const preimageHex = preimageToHex(tc.getInputPreimage(tokenIdx, SIGHASH_ALL_FORKID));
    const sigRaw = tc.getTxFormatSig(S.signer.privKey, tokenIdx, SIGHASH_ALL_FORKID);
    const senderSig = typeof sigRaw === 'string' ? sigRaw : scryptlib.toHex(sigRaw);
    const checkerProof = new ProofClasses.TxOutputProof(TokenUtil.getTxOutputProof(new mvc.Transaction(S.checker.txHex), S.checker.vout));
    const tokenCall = tokenInst.unlock({
      txPreimage: new scryptlib.SigHashPreimage(preimageHex),
      prevouts: new scryptlib.Bytes(prevouts.toHex()),
      tokenInputIndex: tokenIdx,
      amountCheckHashIndex: S.checker.type - 1,
      amountCheckInputIndex: chkIdx,
      amountCheckTxOutputProofInfo: checkerProof,
      amountCheckScript: new scryptlib.Bytes(hexB(S.checker.scriptBuf)),
      prevTokenInputIndex: S.prevTokenInputIndex,
      prevTokenAddress: new scryptlib.Bytes(prevTokenAddress),
      prevTokenAmount,
      tokenTxHeader,
      tokenTxInputProof,
      prevTokenTxOutputProof,
      senderPubKey: new scryptlib.PubKey(senderPubKeyHex),
      senderSig: new scryptlib.Sig(senderSig),
      contractInputIndex: 0,
      contractTxOutputProof: new ProofClasses.TxOutputProof(TokenUtil.getEmptyTxOutputProof()),
      operation: OP_TRANSFER,
    });
    tc.getInput(tokenIdx).setScript(tokenCall.toScript());

    // checker leg: TransferCheck op=1 family (receiver = raw receiver), OCS preimage
    const checkInst = TokenTransferCheckFactory.createContract(S.checker.type);
    if (S.checker.dataPartObj) (checkInst as any).setFormatedDataPart(S.checker.dataPartObj);
    const tokProof = TokenUtil.getTxOutputProof(tokenTx, S.tokenVout);
    const checkPreimage = buildOcsCheckPreimage(tc, chkIdx, S.checker.scriptBuf, S.checker.sats);
    const checkCall = checkInst.unlock({
      txPreimage: new scryptlib.SigHashPreimage(checkPreimage),
      prevouts: new scryptlib.Bytes(prevouts.toHex()),
      tokenScript: new scryptlib.Bytes(hexB(tokenScriptBuf)),
      tokenTxHeaderArray: new scryptlib.Bytes(hexB(Buffer.from(tokProof.txHeader.serialize(), 'hex'))),
      tokenTxHashProofArray: new scryptlib.Bytes(
        hexB(Buffer.concat([TokenUtil.getUInt32Buf(Buffer.from(tokProof.hashProof.serialize(), 'hex').length), Buffer.from(tokProof.hashProof.serialize(), 'hex')])),
      ),
      tokenSatoshiBytesArray: new scryptlib.Bytes(hexB(Buffer.from(tokProof.satoshiBytes.serialize(), 'hex'))),
      inputTokenAddressArray: new scryptlib.Bytes(hexB(Buffer.from(dp.tokenAddress as string, 'hex'))),
      inputTokenAmountArray: new scryptlib.Bytes(
        hexB(
          (() => {
            const b = Buffer.alloc(8);
            b.writeBigUInt64LE(S.tokenAmount);
            return b;
          })(),
        ),
      ),
      tokenOutputSatoshis: Number(tokenSats),
      changeSatoshis: Number(changeSat),
      changeAddress: new scryptlib.Ripemd160(senderH160.toString('hex')),
      opReturnScript: new scryptlib.Bytes(''),
    });
    tc.getInput(chkIdx).setScript(checkCall.toScript());

    // funding leg: session bot P2PKH
    tc.unlockP2PKHInput(S.signer.privKey, fundIdx, SIGHASH_ALL_FORKID);

    // deterministic fee convergence
    const feeTarget = BigInt(Math.ceil(estimateTxLenMax(tc) * feeRate));
    const spentFee = inSatSum - fixedOut - changeSat;
    const verdicts = {
      token: classifyVerify(tokenCall.verify({ tx: tc.getTx(), inputIndex: tokenIdx, inputSatoshis: Number(tokenSats) })),
      checker: runBareInterpreter(tc.getInput(chkIdx).script.toBuffer(), S.checker.scriptBuf, tc.getTx(), chkIdx, S.checker.sats),
    };
    wired = { tokenCall, checkCall, verdicts };
    if (spentFee >= feeTarget && spentFee - feeTarget < 3n) {
      finalFee = spentFee;
      break;
    }
    changeSat = inSatSum - fixedOut - feeTarget;
    if (changeSat > 0n && changeSat < 600n) changeSat = 0n;
  }
  if (!built || !wired) throw new Error('TRANSFER fee loop not converged');
  return {
    tc: built.tc,
    txHex: built.tc.getTx().serialize(true),
    txid: consensusTxId(built.tc),
    fee: finalFee,
    size: built.tc.getTx().toBuffer().length,
    rounds,
    inSatSum,
    tokenSats,
    tokenOutScript,
    receiverH160Hex: receiverH160.toString('hex'),
    outIdx: { token: built.tokenOutIdx, change: built.changeIdx },
    prev: { prevTokenAddress, prevTokenAmount, prevVout },
    verdicts: wired.verdicts,
  };
}

// ---------- TAKE (op=2) assembly ----------
export interface TakeTxStaticInputs {
  listTxHex: string; // LIST raw tx carrying the sale token utxo
  tokenTxid: string; // consensus id of listTxHex (fail-fast)
  tokenVout: number;
  seedTxHex?: string; // seed birth tx raw (defaults to listTxHex = same-tx shape)
  seedTxid: string;
  seedVout: number;
  sellPriceSats: bigint;
  sellerH160Buf: Buffer;
  prevTokenTxHex: string; // DIRECT parent of the LIST token leg (backtrace adjacency lock)
  prevTokenInputIndex: number; // token leg input slot inside LIST (default 0)
  tokenAmount: bigint;
  receiverH160Buf: Buffer;
  changeH160Buf: Buffer;
  checker?: CheckerCast; // op=2 family cast (receiver = taker)
  funding: SimpleFundingUtxo;
  takerSigner: TokenSellSigner;
  /** sat/byte fee floor; the live-fire legs converged at 1. */
  feeRate?: number;
}

export interface TakeTxResult {
  tc: any;
  txHex: string;
  txid: string;
  fee: bigint;
  size: number;
  rounds: number;
  newTokenScript: Buffer;
  sigSingleOk: boolean;
  outIdx: { token: number; price: number; change: number };
  verdicts: { token: VerifyVerdict; checker?: VerifyVerdict; seed: VerifyVerdict };
}

/** Preimage tail extractor: …| hashOutputs(32) | nLockTime(4) | sigHashType(4LE). */
export function preimageTailFields(preimageHex: string): { hashOutputs: Buffer; nLockTime: Buffer; sigHashType: Buffer } {
  const px = Buffer.from(preimageHex, 'hex');
  const sigHashType = px.subarray(px.length - 4);
  const nLockTime = px.subarray(px.length - 8, px.length - 4);
  const hashOutputs = px.subarray(px.length - 40, px.length - 8);
  return { hashOutputs, nLockTime, sigHashType };
}

export function serializeOutput(scriptBuf: Buffer, satoshis: bigint | number): Buffer {
  const sat = Buffer.alloc(8);
  sat.writeBigUInt64LE(BigInt(satoshis));
  const lenByte =
    scriptBuf.length < 253
      ? Buffer.from([scriptBuf.length])
      : Buffer.concat([Buffer.from([0xfd]), (() => {
          const b = Buffer.alloc(2);
          b.writeUInt16LE(scriptBuf.length);
          return b;
        })()]);
  return Buffer.concat([sat, lenByte, scriptBuf]);
}

/**
 * Taker tx: in0 = sale token utxo (op=2 UNLOCK_FROM_CONTRACT), in1 = TokenSell
 * seed (SIGHASH_SINGLE binds out1 = price→seller), in2 = op=2 checker (OCS
 * leg, 12-param ABI with otherOutputArray), in3 = taker funding P2PKH →
 * out0 = token→receiver, out1 = price→seller, out2 = change.
 */
export function buildTakeTx(P: TakeTxStaticInputs): TakeTxResult {
  const listTx = new mvc.Transaction(P.listTxHex);
  if (listTx.id !== P.tokenTxid) throw new Error(`LIST raw consensus id ${listTx.id} != ${P.tokenTxid}`);
  const seedTx = new mvc.Transaction(P.seedTxHex || P.listTxHex);
  const seedScriptBuf = seedTx.outputs[P.seedVout].script.toBuffer();
  const seedSats = BigInt(seedTx.outputs[P.seedVout].satoshis);
  const saleScriptBuf = listTx.outputs[P.tokenVout].script.toBuffer();
  const saleSats = BigInt(listTx.outputs[P.tokenVout].satoshis);
  const saleDp = parseTokenDataPart(saleScriptBuf);
  const tokenAmount = P.tokenAmount;
  // CONSTRUCTION-PATH HARD GATE: the take must carry the FULL listed amount
  // (conservation) and a positive integer price.
  assertTokenSellAmountGates({
    priceSats: P.sellPriceSats,
    listedTokenAmount: tokenAmount,
    utxoTokenAmount: BigInt(String(saleDp.tokenAmount)),
  });

  // Direct-parent lineage (backtrace adjacency): prevTokenTx must be the tx
  // the LIST token input actually points at.
  const prevTokenTx = new mvc.Transaction(P.prevTokenTxHex);
  const prevVout = listTx.inputs[P.prevTokenInputIndex].outputIndex;
  const prevDp = parseTokenDataPart(prevTokenTx.outputs[prevVout].script.toBuffer());
  const prevTokenAddress = Buffer.from(prevDp.tokenAddress as string, 'hex').toString('hex');
  const prevTokenAmount = BigInt(String(prevDp.tokenAmount));
  {
    const parentBuf = Buffer.from(listTx.inputs[P.prevTokenInputIndex].prevTxId);
    const want = prevTokenTx.id;
    if (parentBuf.toString('hex') !== want && Buffer.from(parentBuf).reverse().toString('hex') !== want) {
      throw new Error(
        `prev-token tx mismatch: ${prevTokenTx.id.slice(0, 8)}… != LIST input parent — pass the DIRECT parent of the LIST token leg (backtrace adjacency lock)`,
      );
    }
  }

  const hasChecker = !!P.checker;
  const newTokenScript = getNewTokenScript(saleScriptBuf, P.receiverH160Buf, tokenAmount);
  const inSatSum = saleSats + seedSats + (hasChecker ? P.checker!.sats : 0n) + P.funding.sats;
  const outFixedSat = saleSats + P.sellPriceSats;
  const feeRate = Number(P.feeRate) > 0 ? Number(P.feeRate) : 1;
  let changeSatoshis = inSatSum - outFixedSat - 20000n;
  let built: { tc: any; tokenIdx: number; seedIdx: number; chkIdx: number; fundIdx: number; tokenOutIdx: number; priceOutIdx: number; changeIdx: number } | null = null;
  let wired: { sigSingleOk: boolean; verdicts: { token: VerifyVerdict; checker?: VerifyVerdict; seed: VerifyVerdict } } | null = null;
  let rounds = 0;
  let finalFee = 0n;
  for (let round = 0; round < 8; round++) {
    rounds = round + 1;
    const tc = new TxComposer(new mvc.Transaction());
    const tokenIdx = tc.appendInput({ txId: P.tokenTxid, outputIndex: P.tokenVout, satoshis: Number(saleSats), lockingScript: new mvc.Script(saleScriptBuf) });
    if (tokenIdx !== 0) throw new Error('token leg must be input index 0');
    const seedIdx = tc.appendInput({ txId: P.seedTxid, outputIndex: P.seedVout, satoshis: Number(seedSats), lockingScript: new mvc.Script(seedScriptBuf) });
    let chkIdx = -1;
    if (hasChecker) chkIdx = tc.appendInput({ txId: P.checker!.txid, outputIndex: P.checker!.vout, satoshis: Number(P.checker!.sats), lockingScript: new mvc.Script(P.checker!.scriptBuf) });
    const fundIdx = tc.appendInput({ txId: P.funding.txid, outputIndex: P.funding.vout, satoshis: Number(P.funding.sats), lockingScript: new mvc.Script(p2pkhScript(P.changeH160Buf)) });
    const tokenOutIdx = tc.appendOutput({ lockingScript: new mvc.Script(newTokenScript), satoshis: Number(saleSats) });
    const priceOutIdx = tc.appendOutput({ lockingScript: new mvc.Script(p2pkhScript(P.sellerH160Buf)), satoshis: Number(P.sellPriceSats) });
    let changeIdx = -1;
    if (changeSatoshis > 0n) changeIdx = tc.appendOutput({ lockingScript: new mvc.Script(p2pkhScript(P.changeH160Buf)), satoshis: Number(changeSatoshis) });
    built = { tc, tokenIdx, seedIdx, chkIdx, fundIdx, tokenOutIdx, priceOutIdx, changeIdx };

    const prevouts = new Prevouts();
    prevouts.addVout(P.tokenTxid, P.tokenVout);
    prevouts.addVout(P.seedTxid, P.seedVout);
    if (hasChecker) prevouts.addVout(P.checker!.txid, P.checker!.vout);
    prevouts.addVout(P.funding.txid, P.funding.vout);

    // token leg: op=2 UNLOCK_FROM_CONTRACT (signature slot is the op=2
    // placeholder — this branch has no sender checkSig)
    const inputRes = TokenUtil.getTxInputProof(listTx, P.prevTokenInputIndex);
    const ProofClasses = scryptlib.buildTypeClasses(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('meta-contract/dist/mcp02/contract-desc/txUtil_desc.json'),
    );
    const tokenTxInputProof = rebuildTxInputProof(ProofClasses, inputRes[0]);
    const tokenTxHeader = inputRes[1];
    const prevTokenTxOutputProof = new ProofClasses.TxOutputProof(TokenUtil.getTxOutputProof(prevTokenTx, prevVout));
    const contractTxOutputProof = new ProofClasses.TxOutputProof(TokenUtil.getTxOutputProof(seedTx, P.seedVout));
    const token = newTokenContract();
    token.setFormatedDataPart(saleDp as any);
    const preimageTokenHex = preimageToHex(tc.getInputPreimage(tokenIdx, SIGHASH_ALL_FORKID));
    const tokenCall = token.unlock({
      txPreimage: new scryptlib.SigHashPreimage(preimageTokenHex),
      prevouts: new scryptlib.Bytes(prevouts.toHex()),
      tokenInputIndex: tokenIdx,
      amountCheckHashIndex: hasChecker ? P.checker!.type - 1 : 0,
      amountCheckInputIndex: hasChecker ? chkIdx : 0,
      amountCheckTxOutputProofInfo: hasChecker
        ? new ProofClasses.TxOutputProof(TokenUtil.getTxOutputProof(new mvc.Transaction(P.checker!.txHex), P.checker!.vout))
        : new ProofClasses.TxOutputProof(TokenUtil.getEmptyTxOutputProof()),
      amountCheckScript: hasChecker ? new scryptlib.Bytes(hexB(P.checker!.scriptBuf)) : new scryptlib.Bytes(''),
      prevTokenInputIndex: P.prevTokenInputIndex,
      prevTokenAddress: new scryptlib.Bytes(prevTokenAddress),
      prevTokenAmount,
      tokenTxHeader,
      tokenTxInputProof,
      prevTokenTxOutputProof,
      senderPubKey: new scryptlib.PubKey(utils.PLACE_HOLDER_PUBKEY),
      senderSig: new scryptlib.Sig(utils.PLACE_HOLDER_SIG),
      contractInputIndex: seedIdx,
      contractTxOutputProof,
      operation: OP_UNLOCK_FROM_CONTRACT,
    });
    tc.getInput(tokenIdx).setScript(tokenCall.toScript());

    // checker leg: TokenUnlockContractCheck (op=2 family, 12-param ABI)
    let checkCall: { toScript: () => mvc.Script; verify: (o: unknown) => unknown } | null = null;
    if (hasChecker) {
      const checkInst = (TokenUnlockContractCheckFactory as any).createContract(P.checker!.type);
      if (P.checker!.dataPartObj) (checkInst as any).setFormatedDataPart(P.checker!.dataPartObj);
      const checkPreimage = buildOcsCheckPreimage(tc, chkIdx, P.checker!.scriptBuf, P.checker!.sats);
      const tokProof = TokenUtil.getTxOutputProof(listTx, P.tokenVout);
      const mkOther = (scriptBuf: Buffer, sats: bigint | number) => {
        const sb = Buffer.alloc(8);
        sb.writeBigUInt64LE(BigInt(sats));
        // writeVarint(buf) = varint(len) ‖ buf — carries the script body (SDK burn shape)
        const body = Buffer.concat([sb, TokenUtil.writeVarint(scriptBuf)]);
        return Buffer.concat([TokenUtil.getUInt32Buf(body.length), body]);
      };
      const otherOutputArray = Buffer.concat([
        mkOther(p2pkhScript(P.sellerH160Buf), P.sellPriceSats),
        ...(changeSatoshis > 0n ? [mkOther(p2pkhScript(P.changeH160Buf), changeSatoshis)] : []),
      ]);
      checkCall = checkInst.unlock({
        txPreimage: new scryptlib.SigHashPreimage(checkPreimage),
        prevouts: new scryptlib.Bytes(prevouts.toHex()),
        tokenScript: new scryptlib.Bytes(hexB(saleScriptBuf)),
        tokenTxHeaderArray: new scryptlib.Bytes(hexB(Buffer.from(tokProof.txHeader.serialize(), 'hex'))),
        tokenTxHashProofArray: new scryptlib.Bytes(
          hexB(Buffer.concat([TokenUtil.getUInt32Buf(Buffer.from(tokProof.hashProof.serialize(), 'hex').length), Buffer.from(tokProof.hashProof.serialize(), 'hex')])),
        ),
        tokenSatoshiBytesArray: new scryptlib.Bytes(hexB(Buffer.from(tokProof.satoshiBytes.serialize(), 'hex'))),
        inputTokenAddressArray: new scryptlib.Bytes(hexB(Buffer.from(saleDp.tokenAddress as string, 'hex'))),
        inputTokenAmountArray: new scryptlib.Bytes(
          hexB(
            (() => {
              const b = Buffer.alloc(8);
              b.writeBigUInt64LE(tokenAmount);
              return b;
            })(),
          ),
        ),
        nOutputs: tc.getTx().outputs.length,
        tokenOutputIndexArray: new scryptlib.Bytes(TokenUtil.getUInt32Buf(built.tokenOutIdx).toString('hex')),
        tokenOutputSatoshis: Number(saleSats),
        otherOutputArray: new scryptlib.Bytes(hexB(otherOutputArray)),
      });
      tc.getInput(chkIdx).setScript(checkCall!.toScript());
    }

    // seed leg: TokenSell.unlock(preimage @ SIGHASH_SINGLE|FORKID) binds out1 = price
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const seedDesc = require('meta-contract/dist/mcp02/contract-desc/tokenSell_desc.json');
    const SeedC = scryptlib.buildContractClass(seedDesc) as any;
    const seedContract = new SeedC(new scryptlib.Ripemd160(P.sellerH160Buf.toString('hex')), Number(P.sellPriceSats));
    const preimageSeed = tc.getInputPreimage(seedIdx, SIGHASH_SINGLE_FORKID);
    const preimageSeedHex = preimageToHex(preimageSeed);
    const seedCall = seedContract.unlock(preimageSeed instanceof scryptlib.SigHashPreimage ? preimageSeed : new scryptlib.SigHashPreimage(preimageSeedHex));
    tc.getInput(seedIdx).setScript(seedCall.toScript());

    // funding leg
    tc.unlockP2PKHInput(P.takerSigner.privKey, fundIdx, SIGHASH_ALL_FORKID);

    // SIG_SINGLE binding closure: preimage hashOutputs == hash256(serializeOutput(out1))
    const tail = preimageTailFields(preimageSeedHex);
    const sigSingleOk =
      tail.sigHashType.toString('hex') === '43000000' &&
      tail.hashOutputs.toString('hex') === hexB(d256(serializeOutput(p2pkhScript(P.sellerH160Buf), P.sellPriceSats)));

    const feeTarget = BigInt(Math.ceil(estimateTxLenMax(tc) * feeRate));
    const unspent = inSatSum - outFixedSat - changeSatoshis;
    const verdicts: { token: VerifyVerdict; checker?: VerifyVerdict; seed: VerifyVerdict } = {
      token: classifyVerify(tokenCall.verify({ tx: tc.getTx(), inputIndex: tokenIdx, inputSatoshis: Number(saleSats) })),
      ...(hasChecker
        ? {
            checker: runBareInterpreter(tc.getInput(chkIdx).script.toBuffer(), P.checker!.scriptBuf, tc.getTx(), chkIdx, P.checker!.sats),
          }
        : {}),
      seed: classifyVerify(seedCall.verify({ tx: tc.getTx(), inputIndex: seedIdx, inputSatoshis: Number(seedSats) })),
    };
    wired = { sigSingleOk, verdicts };
    if (unspent >= feeTarget && unspent - feeTarget < 3n) {
      finalFee = unspent;
      break;
    }
    changeSatoshis = inSatSum - outFixedSat - feeTarget;
    if (changeSatoshis > 0n && changeSatoshis < 600n) changeSatoshis = 0n;
  }
  if (!built || !wired) throw new Error('take fee loop not converged');
  return {
    tc: built.tc,
    txHex: built.tc.getTx().serialize(true),
    txid: consensusTxId(built.tc),
    fee: finalFee,
    size: built.tc.getTx().toBuffer().length,
    rounds,
    newTokenScript,
    sigSingleOk: wired.sigSingleOk,
    outIdx: { token: built.tokenOutIdx, price: built.priceOutIdx, change: built.changeIdx },
    verdicts: wired.verdicts,
  };
}
