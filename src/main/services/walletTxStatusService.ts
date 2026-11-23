/**
 * Wallet Tx Status & Payment Verification (Phase 1 / T2+T3)
 *
 * `wallet_tx_status`: is a tx on-chain yet? `wallet_tx_verify`: did a payment
 * actually deliver what the agent claims? Both were missing from the agent
 * surface — after the Phase 0 incident the bot had no way to double-check a
 * balance or a transfer without improvising curl calls.
 *
 * Data sources are the endpoints already battle-tested inside this repo:
 *
 * - MVC raw tx: metalet v4 `tx/raw` (txTransferVerification), parsed locally
 *   with the pure-JS output parser. MVC has no reachable public tx-status
 *   JSON API (mvcscan serves an SPA; explorer.microvisionchain.com is
 *   unreachable), so CONFIRMATION is DERIVED: when a receiver address is
 *   known, the receiver's metalet v4 `address/utxo-list` is walked — an
 *   output of this tx found there with height > 0 is confirmed (the same
 *   height rule wallet_balance uses). A spent-onward output drops out of the
 *   UTXO set, so "no row" is reported honestly as unconfirmed-or-spent.
 * - BTC: mempool.space ESPLORA `/api/tx/<id>` (full status JSON incl. block
 *   height/time/fee/vout addresses) + `/api/blocks/tip/height` for the
 *   confirmations count.
 * - DOGE: blockchair `dashboards/transaction/<id>` (block_id/time/fee plus
 *   outputs with recipient addresses). blockchair indexes confirmed txs;
 *   a pending DOGE tx reports as not-found until it mines.
 *
 * Verification verdicts are evidence-graded: VERIFIED only on tx-level
 * decode; the MVC20 receiver-side balance check (shared balance-list source)
 * rides along as supporting evidence, labeled as such.
 */

import Decimal from 'decimal.js';
import { createHash } from 'node:crypto';
import {
  fetchRawTxHexFromMetalet,
  parseTxOutputs,
  extractPubkeyHashFromScript,
  pubkeyHashFromAddress,
  verifyTransferToRecipient,
  type VerifyTransferResult,
} from './txTransferVerification';
import { listMvcFtAssets, type MvcFtAsset } from './mvcFtService';

const METALET_HOST = 'https://www.metalet.space';
const MEMPOOL_HOST = 'https://mempool.space';
const BLOCKCHAIR_HOST = 'https://api.blockchair.com';
const NET = 'livenet';
const MAX_UTXO_PAGES = 20;
/** MVC20 token amount is a little-endian 64-bit integer in the script. */
const MVC20_AMOUNT_LENGTH = 8;

export type WalletTxChain = 'mvc' | 'btc' | 'doge';

export interface WalletTxOutput {
  index: number;
  /** Base58/bech32 address when derivable (P2PKH/P2SH/P2WPKH or the source's own field). */
  address?: string;
  sats?: number;
  /** Raw script hex (internal: the MVC20 verifier decodes token payloads from it). */
  scriptHex?: string;
}

export interface WalletTxStatus {
  chain: WalletTxChain;
  txid: string;
  /** The tx is known to the network/indexer (raw tx retrievable / API hit). */
  found: boolean;
  /** Proven confirmed. Absent = unknown (no confirmation source for this query). */
  confirmed?: boolean;
  blockHeight?: number;
  confirmations?: number;
  feeSats?: number;
  blockTimeIso?: string;
  outputs: WalletTxOutput[];
  /** How the status facts were derived. */
  evidence: 'block-source' | 'receiver-utxo-list' | 'raw-tx-only' | 'not-found';
  note?: string;
  explorerUrl: string;
}

export type WalletTxVerifyVerdict = 'VERIFIED' | 'MISMATCH' | 'NOT_FOUND' | 'INSUFFICIENT_EVIDENCE';

export interface WalletTxVerifyInput {
  chain: WalletTxChain;
  txid: string;
  receiver?: string;
  /** Native-coin expectation in sats (MVC SPACE / BTC / DOGE). */
  amountSats?: number;
  toleranceSats?: number;
  /** MVC20 expectation. tokenAmount (display units) requires receiver. */
  tokenGenesis?: string;
  tokenCodehash?: string;
  tokenAmount?: string;
}

export interface WalletTxVerifyResult {
  verdict: WalletTxVerifyVerdict;
  chain: WalletTxChain;
  txid: string;
  confirmed?: boolean;
  reasons: string[];
  matched: Array<{ index: number; address?: string; sats?: number; tokenAmount?: string }>;
  actual?: { sats?: number; tokenBaseUnits?: string; tokenDisplay?: string };
  token?: { symbol?: string; genesis: string; decimal?: number; receiverBalance?: string };
  status: WalletTxStatus;
}

export interface WalletTxStatusDeps {
  fetchMvcRawTxHex?: (txid: string) => Promise<string>;
  fetchMvcUtxoList?: (
    address: string,
  ) => Promise<Array<{ txid?: string; outIndex?: number; height?: number }>>;
  fetchBtcTx?: (txid: string) => Promise<Record<string, unknown> | null>;
  fetchBtcTipHeight?: () => Promise<number | null>;
  fetchDogeTx?: (txid: string) => Promise<Record<string, unknown> | null>;
  listReceiverFtAssets?: typeof listMvcFtAssets;
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as Error).message === 'string') {
    return (error as Error).message;
  }
  return String(error ?? '');
}

/** Base58Check encode (MVC mainnet P2PKH, version byte 0x00) from hash160. */
function base58CheckEncode(hash160Hex: string): string | null {
  if (!/^[0-9a-f]{40}$/.test(hash160Hex)) return null;
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const payload = Buffer.concat([Buffer.from([0x00]), Buffer.from(hash160Hex, 'hex')]);
  const checksum = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest().subarray(0, 4);
  const bytes = Buffer.concat([payload, checksum]);
  let num = BigInt(0);
  for (const byte of bytes) num = num * 256n + BigInt(byte);
  let encoded = '';
  while (num > 0n) {
    encoded = ALPHABET[Number(num % 58n)] + encoded;
    num /= 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) encoded = '1' + encoded;
    else break;
  }
  return encoded;
}

function mvcOutputAddress(scriptHex: string | undefined): string | undefined {
  if (!scriptHex) return undefined;
  const hash = extractPubkeyHashFromScript(scriptHex);
  return hash ? base58CheckEncode(hash) ?? undefined : undefined;
}

function unixSecondsToIso(seconds: unknown): string | undefined {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value * 1000).toISOString();
}

function blockchairTimeToIso(value: unknown): string | undefined {
  const text = String(value || '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(text);
  if (!match) return undefined;
  const parsed = new Date(`${match[1]}T${match[2]}Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/* ------------------------------------------------------------------ */
/* Production fetchers (all endpoints verified live or in-repo)        */
/* ------------------------------------------------------------------ */

async function fetchMvcRawTxHexDefault(txid: string): Promise<string> {
  try {
    return await fetchRawTxHexFromMetalet('mvc', txid);
  } catch {
    return '';
  }
}

/** Walk the metalet v4 utxo-list pages (flag pagination, walletQueryService pattern). */
async function fetchMvcUtxoListDefault(address: string) {
  const rows: Array<{ txid?: string; outIndex?: number; height?: number }> = [];
  let flag: string | undefined;
  for (let page = 0; page < MAX_UTXO_PAGES; page++) {
    const params = new URLSearchParams({ address, net: NET });
    if (flag) params.set('flag', flag);
    const response = await fetch(`${METALET_HOST}/wallet-api/v4/mvc/address/utxo-list?${params}`);
    const json = (await response.json()) as {
      code?: number;
      message?: string;
      data?: { list?: Array<{ txid?: string; outIndex?: number; height?: number; flag?: string }> };
    };
    if (json.code !== 0 && json.code !== undefined) {
      throw new Error(json.message || 'mvc utxo-list failed');
    }
    const list = json.data?.list ?? [];
    if (list.length === 0) break;
    for (const row of list) {
      rows.push({ txid: row.txid, outIndex: row.outIndex, height: row.height });
      if (typeof row.flag === 'string' && row.flag) flag = row.flag;
    }
    if (!flag) break;
  }
  return rows;
}

async function fetchBtcTxDefault(txid: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${MEMPOOL_HOST}/api/tx/${encodeURIComponent(txid)}`);
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function fetchBtcTipHeightDefault(): Promise<number | null> {
  try {
    const response = await fetch(`${MEMPOOL_HOST}/api/blocks/tip/height`);
    if (!response.ok) return null;
    const text = await response.text();
    const height = Number(text.trim());
    return Number.isInteger(height) && height > 0 ? height : null;
  } catch {
    return null;
  }
}

async function fetchDogeTxDefault(txid: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${BLOCKCHAIR_HOST}/dogecoin/dashboards/transaction/${encodeURIComponent(txid)}`);
    if (!response.ok) return null;
    const json = (await response.json()) as { data?: Record<string, unknown> };
    const entry = json.data?.[txid];
    return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

const EXPLORER_URLS: Record<WalletTxChain, (txid: string) => string> = {
  mvc: (txid) => `https://www.mvcscan.com/tx/${txid}`,
  btc: (txid) => `https://mempool.space/tx/${txid}`,
  doge: (txid) => `https://dogechain.info/tx/${txid}`,
};

export async function getWalletTxStatus(
  deps: WalletTxStatusDeps,
  input: { chain: WalletTxChain; txid: string; receiver?: string },
): Promise<WalletTxStatus> {
  const chain = input.chain;
  const txid = String(input.txid || '').trim().toLowerCase();
  const receiver = String(input.receiver || '').trim();

  if (chain === 'btc') {
    const tx = await (deps.fetchBtcTx ?? fetchBtcTxDefault)(txid);
    if (!tx) {
      return { chain, txid, found: false, outputs: [], evidence: 'not-found', explorerUrl: EXPLORER_URLS.btc(txid) };
    }
    const status = (tx.status ?? {}) as { confirmed?: boolean; block_height?: number; block_time?: number };
    const vout = Array.isArray(tx.vout) ? (tx.vout as Array<Record<string, unknown>>) : [];
    const blockHeight = Number.isInteger(status.block_height) ? Number(status.block_height) : undefined;
    let confirmations: number | undefined;
    if (status.confirmed && blockHeight) {
      const tip = await (deps.fetchBtcTipHeight ?? fetchBtcTipHeightDefault)();
      if (tip != null && tip >= blockHeight) confirmations = tip - blockHeight + 1;
    }
    return {
      chain,
      txid,
      found: true,
      confirmed: status.confirmed === true,
      blockHeight,
      confirmations,
      feeSats: Number.isFinite(Number(tx.fee)) ? Number(tx.fee) : undefined,
      blockTimeIso: unixSecondsToIso(status.block_time),
      outputs: vout.map((out, index) => ({
        index,
        address: typeof out.scriptpubkey_address === 'string' ? out.scriptpubkey_address : undefined,
        sats: Number.isFinite(Number(out.value)) ? Number(out.value) : undefined,
      })),
      evidence: 'block-source',
      explorerUrl: EXPLORER_URLS.btc(txid),
    };
  }

  if (chain === 'doge') {
    const entry = await (deps.fetchDogeTx ?? fetchDogeTxDefault)(txid);
    if (!entry) {
      return {
        chain,
        txid,
        found: false,
        outputs: [],
        evidence: 'not-found',
        note: 'blockchair indexes confirmed DOGE txs; a pending tx reports as not-found until it mines',
        explorerUrl: EXPLORER_URLS.doge(txid),
      };
    }
    const transaction = (entry.transaction ?? {}) as Record<string, unknown>;
    const outputs = Array.isArray(entry.outputs) ? (entry.outputs as Array<Record<string, unknown>>) : [];
    const blockId = Number(transaction.block_id);
    return {
      chain,
      txid,
      found: true,
      confirmed: Number.isInteger(blockId) && blockId > 0,
      blockHeight: blockId > 0 ? blockId : undefined,
      feeSats: Number.isFinite(Number(transaction.fee)) ? Number(transaction.fee) : undefined,
      blockTimeIso: blockchairTimeToIso(transaction.time),
      outputs: outputs.map((out, index) => ({
        index,
        address: typeof out.recipient === 'string' ? out.recipient : undefined,
        sats: Number.isFinite(Number(out.value)) ? Number(out.value) : undefined,
      })),
      evidence: 'block-source',
      explorerUrl: EXPLORER_URLS.doge(txid),
    };
  }

  // MVC: raw tx retrievable + receiver-utxo-list confirmation derivation.
  const fetchRaw = deps.fetchMvcRawTxHex ?? fetchMvcRawTxHexDefault;
  const rawHex = String((await fetchRaw(txid)) || '');
  if (!rawHex) {
    return { chain, txid, found: false, outputs: [], evidence: 'not-found', explorerUrl: EXPLORER_URLS.mvc(txid) };
  }
  const outputs: WalletTxOutput[] = parseTxOutputs(rawHex).map((out, index) => ({
    index,
    address: mvcOutputAddress(out.scriptPubKeyHex),
    sats: out.valueSats,
    scriptHex: out.scriptPubKeyHex,
  }));

  if (!receiver) {
    return {
      chain,
      txid,
      found: true,
      outputs,
      evidence: 'raw-tx-only',
      note: 'tx exists in the network view (raw tx retrievable); confirmation unknown — pass receiver for the utxo-based check',
      explorerUrl: EXPLORER_URLS.mvc(txid),
    };
  }

  const fetchUtxos = deps.fetchMvcUtxoList ?? fetchMvcUtxoListDefault;
  const rows = await fetchUtxos(receiver);
  const outIndexes = new Set(outputs.map((out) => out.index));
  let matchedHeight: number | null = null;
  for (const row of rows) {
    if (String(row.txid || '').toLowerCase() !== txid) continue;
    if (row.outIndex != null && !outIndexes.has(Number(row.outIndex))) continue;
    const height = Number(row.height ?? 0);
    if (height > 0) {
      matchedHeight = height;
      break;
    }
  }
  if (matchedHeight != null) {
    return {
      chain,
      txid,
      found: true,
      confirmed: true,
      blockHeight: matchedHeight,
      outputs,
      evidence: 'receiver-utxo-list',
      explorerUrl: EXPLORER_URLS.mvc(txid),
    };
  }
  return {
    chain,
    txid,
    found: true,
    confirmed: false,
    outputs,
    evidence: 'receiver-utxo-list',
    note:
      `no unspent output of this tx found in ${receiver}'s UTXO set — the tx is either still unconfirmed ` +
      `or its outputs were already spent onward`,
    explorerUrl: EXPLORER_URLS.mvc(txid),
  };
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

interface TokenOutputDecode {
  index: number;
  genesisHash: string;
  codeHash?: string;
  tokenAmount?: string;
  receiverHash160?: string;
  decimal?: number;
  symbol?: string;
  tokenName?: string;
}

/**
 * Decode MVC20 token payloads from the raw output scripts via the
 * meta-contract token.proto getters (round-trip verified: getGenesisHash /
 * getTokenAmount / getTokenAddress read the tail-relative dataPart from a
 * raw hex buffer). Any decode failure degrades that output to "undecoded"
 * without failing the whole verification.
 */
function decodeMvc20Outputs(outputs: WalletTxOutput[]): TokenOutputDecode[] {
  let ftProto: Record<string, (...args: unknown[]) => unknown>;
  try {
    ftProto = require('meta-contract/dist/mcp02/contract-proto/token.proto.js');
  } catch {
    return [];
  }
  const decoded: TokenOutputDecode[] = [];
  for (const output of outputs) {
    if (!output.scriptHex) continue;
    try {
      const script = Buffer.from(output.scriptHex, 'hex');
      const genesisHash = String(ftProto.getGenesisHash(script) ?? '');
      if (!/^[0-9a-f]{40}$/.test(genesisHash)) continue;
      const entry: TokenOutputDecode = { index: output.index, genesisHash };
      try {
        const codeHash = String(ftProto.getContractCodeHash(script) ?? '');
        if (/^[0-9a-f]{40}$/.test(codeHash)) entry.codeHash = codeHash;
      } catch {
        // synthetic/legacy scripts may omit the codehash section
      }
      const amount = ftProto.getTokenAmount(script);
      if (amount != null) {
        const text = String(amount);
        if (/^\d+$/.test(text)) entry.tokenAmount = text;
      }
      try {
        const receiver = String(ftProto.getTokenAddress(script) ?? '');
        if (/^[0-9a-f]{40}$/.test(receiver)) entry.receiverHash160 = receiver;
      } catch {
        // receiver attribution optional
      }
      try {
        const decimal = Number(ftProto.getDecimalNum(script));
        if (Number.isInteger(decimal) && decimal >= 0) entry.decimal = decimal;
      } catch {
        // decimal optional
      }
      try {
        const symbol = String(ftProto.getTokenSymbol(script) ?? '').replace(/\0+$/g, '');
        if (symbol) entry.symbol = symbol;
      } catch {
        // symbol optional
      }
      decoded.push(entry);
    } catch {
      // not a token script (or proto failure) — skip
    }
  }
  return decoded;
}

export async function verifyWalletTx(
  deps: WalletTxStatusDeps,
  input: WalletTxVerifyInput,
): Promise<WalletTxVerifyResult> {
  const chain = input.chain;
  const txid = String(input.txid || '').trim().toLowerCase();
  const reasons: string[] = [];
  const matched: WalletTxVerifyResult['matched'] = [];

  if (!/^[0-9a-f]{64}$/.test(txid)) {
    return {
      verdict: 'INSUFFICIENT_EVIDENCE',
      chain,
      txid,
      reasons: ['txid must be 64 hex'],
      matched,
      status: {
        chain,
        txid,
        found: false,
        outputs: [],
        evidence: 'not-found',
        explorerUrl: EXPLORER_URLS[chain](txid),
      },
    };
  }

  const status = await getWalletTxStatus(deps, {
    chain,
    txid,
    receiver: input.receiver,
  });
  if (!status.found) {
    return {
      verdict: 'NOT_FOUND',
      chain,
      txid,
      reasons: ['tx not found on the network/indexer', status.note].filter(Boolean) as string[],
      matched,
      status,
    };
  }
  if (status.confirmed === true) {
    reasons.push(`tx confirmed${status.blockHeight ? ` at block ${status.blockHeight}` : ''}`);
  } else if (status.confirmed === false) {
    reasons.push('tx not confirmed yet (or outputs already spent onward)');
  } else {
    reasons.push('confirmation status unknown');
  }

  const tokenGenesis = String(input.tokenGenesis || '').trim().toLowerCase() || undefined;
  const nativeExpected = Number.isInteger(input.amountSats) && Number(input.amountSats) > 0;
  let nativeOk = false;
  let tokenOk = false;
  let undecidable = false;

  // Native-coin check (MVC P2PKH / BTC / DOGE).
  if (input.receiver && nativeExpected && !tokenGenesis) {
    if (chain === 'mvc') {
      // Reuse the shared verifier (hash-level matching over the raw tx);
      // feed it the raw hex the status step already fetched.
      let result: VerifyTransferResult;
      try {
        const fetchRaw = deps.fetchMvcRawTxHex ?? fetchMvcRawTxHexDefault;
        result = await verifyTransferToRecipient({
          chain,
          txid,
          recipientAddress: input.receiver,
          expectedAmountSats: Number(input.amountSats),
          toleranceSats: input.toleranceSats,
          fetchRawTxHex: async () => await fetchRaw(txid),
        });
      } catch (error) {
        result = { valid: false, reason: `verify_failed:${getErrorMessage(error)}` };
      }
      if (result.valid) {
        nativeOk = true;
        reasons.push(
          `tx-level decode: ${result.matchedAmountSats} sats delivered to ${input.receiver} ` +
            `(expected ${input.amountSats})`,
        );
        for (const out of status.outputs) {
          if (out.address === input.receiver) {
            matched.push({ index: out.index, address: out.address, sats: out.sats });
          }
        }
      } else {
        reasons.push(`tx-level decode FAILED: ${result.reason}`);
      }
    } else {
      // BTC/DOGE: the source API already provides recipient addresses.
      let total = 0;
      for (const out of status.outputs) {
        if (out.address && out.address === input.receiver) {
          total += out.sats ?? 0;
          matched.push({ index: out.index, address: out.address, sats: out.sats });
        }
      }
      const minAcceptable = Number(input.amountSats) - Math.max(0, input.toleranceSats ?? 0);
      if (total >= minAcceptable) {
        nativeOk = true;
        reasons.push(`source API outputs: ${total} sats to ${input.receiver} (expected ${input.amountSats})`);
      } else {
        reasons.push(`source API outputs: only ${total} sats to ${input.receiver}, expected at least ${minAcceptable}`);
      }
    }
  }

  // MVC20 token check (tx-level decode + receiver-side balance evidence).
  let tokenResult: WalletTxVerifyResult['token'];
  let actual: WalletTxVerifyResult['actual'];
  if (tokenGenesis) {
    if (chain !== 'mvc') reasons.push('tokenGenesis applies to MVC txs only; ignoring for this chain');
    const decoded = decodeMvc20Outputs(status.outputs);
    const candidates = decoded.filter(
      (entry) =>
        entry.genesisHash === tokenGenesis &&
        (!input.tokenCodehash || !entry.codeHash || entry.codeHash === input.tokenCodehash.toLowerCase()),
    );
    const decodable = candidates.filter((entry) => entry.tokenAmount != null);
    for (const entry of decodable) {
      matched.push({
        index: entry.index,
        tokenAmount: entry.tokenAmount,
        ...(entry.receiverHash160 ? { address: base58CheckEncode(entry.receiverHash160) ?? undefined } : {}),
      });
    }
    if (candidates.length === 0) {
      reasons.push(`tx carries no MVC20 output for genesis ${tokenGenesis}`);
    } else if (decodable.length === 0) {
      reasons.push(`token output(s) present for ${tokenGenesis} but the amount could not be decoded`);
    } else {
      let totalBase = 0n;
      for (const entry of decodable) totalBase += BigInt(entry.tokenAmount as string);
      actual = { tokenBaseUnits: totalBase.toString() };

      let decimal: number | undefined;
      let receiverBalance: string | undefined;
      let receiverHash: string | undefined;
      if (input.receiver) {
        receiverHash = pubkeyHashFromAddress(input.receiver) ?? undefined;
        const listAssets = deps.listReceiverFtAssets ?? listMvcFtAssets;
        try {
          const assets: MvcFtAsset[] = await listAssets(input.receiver);
          const entry = assets.find(
            (asset) => String(asset.genesis || '').toLowerCase() === tokenGenesis,
          );
          if (entry) {
            decimal = entry.decimal;
            receiverBalance = entry.balance.display;
            tokenResult = {
              symbol: entry.symbol,
              genesis: tokenGenesis,
              decimal,
              receiverBalance,
            };
          }
        } catch (error) {
          reasons.push(`receiver-side token balance lookup failed: ${getErrorMessage(error)}`);
        }
      }

      const expectedDisplay = String(input.tokenAmount ?? '').trim();
      if (!expectedDisplay) {
        tokenOk = true; // tx-level decode succeeded; no amount comparison requested
        reasons.push(
          `tx-level decode: ${totalBase} base units of ${tokenGenesis} moved` +
            (input.receiver ? '' : ' (pass token_amount + receiver for an amount comparison)'),
        );
      } else if (decimal == null) {
        undecidable = true;
        reasons.push(
          `insufficient-evidence: expected token_amount "${expectedDisplay}" could not be compared — the token's ` +
            `decimal is unknown (pass a receiver that holds the token, or check the balance directly)`,
        );
      } else {
        const expectedBase = new Decimal(expectedDisplay).mul(new Decimal(10).pow(decimal)).toDecimalPlaces(0);
        const expectedBaseText = expectedBase.toFixed(0);
        actual.tokenDisplay = new Decimal(totalBase.toString()).div(new Decimal(10).pow(decimal)).toFixed(decimal);
        if (expectedBaseText === totalBase.toString()) {
          tokenOk = true;
          reasons.push(
            `tx-level decode: ${actual.tokenDisplay} ${tokenResult?.symbol || 'token'} moved (expected ${expectedDisplay})`,
          );
          if (receiverHash) {
            const attributed = decodable.filter((entry) => entry.receiverHash160 === receiverHash);
            let attributedBase = 0n;
            for (const entry of attributed) attributedBase += BigInt(entry.tokenAmount as string);
            if (attributedBase === totalBase) {
              reasons.push(`all token outputs attribute to ${input.receiver}`);
            } else if (attributedBase < BigInt(expectedBaseText)) {
              reasons.push(
                `attribution mismatch: only ${attributedBase} of ${totalBase} base units attribute to ` +
                  `${input.receiver} (expected ${expectedDisplay}) — the rest is token change going elsewhere`,
              );
            } else {
              reasons.push(
                `at least ${expectedBase.toFixed(0)} of ${totalBase} base units attribute to ${input.receiver} ` +
                  `(the rest is token change)`,
              );
            }
          }
          if (receiverBalance != null) {
            const have = new Decimal(receiverBalance);
            const need = new Decimal(expectedDisplay);
            if (have.gte(need)) {
              reasons.push(
                `receiver-side balance check: ${input.receiver} holds ${receiverBalance} ${tokenResult?.symbol || ''} ` +
                  `(>= expected) — supporting evidence`,
              );
            } else {
              reasons.push(
                `receiver-side balance check: ${input.receiver} holds only ${receiverBalance} ` +
                  `(below the expected ${expectedDisplay}) — the tokens may have been spent onward`,
              );
            }
          }
        } else {
          reasons.push(
            `amount mismatch: tx moves ${actual.tokenDisplay} (expected ${expectedDisplay}) in ${tokenResult?.symbol || tokenGenesis}`,
          );
        }
      }
    }
  }

  const hadNativeCheck = Boolean(input.receiver && nativeExpected && !tokenGenesis);
  const hadTokenCheck = Boolean(tokenGenesis);
  let verdict: WalletTxVerifyVerdict;
  if (!hadNativeCheck && !hadTokenCheck) {
    verdict = 'INSUFFICIENT_EVIDENCE';
    reasons.push('no expectation provided: pass receiver+amount_sats (native) or token_genesis+token_amount (MVC20)');
  } else {
    const failed = reasons.some(
      (reason) => /FAILED|mismatch|only |no MVC20 output/.test(reason),
    );
    if (failed) verdict = 'MISMATCH';
    else if ((hadNativeCheck && nativeOk) || (hadTokenCheck && tokenOk)) verdict = 'VERIFIED';
    else verdict = 'INSUFFICIENT_EVIDENCE';
  }

  return {
    verdict,
    chain,
    txid,
    ...(status.confirmed !== undefined ? { confirmed: status.confirmed } : {}),
    reasons,
    matched,
    ...(actual ? { actual } : {}),
    ...(tokenResult ? { token: tokenResult } : {}),
    status,
  };
}
