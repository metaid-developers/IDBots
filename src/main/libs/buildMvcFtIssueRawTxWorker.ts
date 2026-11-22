/**
 * MVC MetaContract FT (MCP02 v2) Issuance & Mint Worker (`buildMvcFtIssueRawTxWorker`).
 *
 * Runs in an isolated child Node process via `ELECTRON_RUN_AS_NODE` (same posture as
 * `buildMvcFtTransferRawTxWorker` and `buildMvcTokenSellRawTxWorker`) so the sCrypt
 * contract engine stays out of the Electron main process, while also exporting pure
 * deterministic builders (`buildMvcFtIssueRawTxLocally` / `buildMvcFtMintRawTxLocally`)
 * for hermetic unit tests.
 *
 * Security & Protocol Guarantees:
 * - Never broadcasts: builds and locally sCrypt-verifies (`debug: true`) raw txs only.
 * - Mnemonic arrives strictly via env (`IDBOTS_METABOT_MNEMONIC` / `IDBOTS_METABOT_PATH`)
 *   and is never echoed in stdout, stderr, or error messages.
 * - Zero-conf `genesis -> initial mint` chaining: feeds the `genesis` contract UTXO
 *   (`vout 0`) and MVC change UTXO (`vout last`) directly into `FtManager.mint` without
 *   sleeping or waiting for external indexers.
 * - Enforces signed 64-bit integer ceiling (`<= 9_223_372_036_854_775_807n`) on MCP02
 *   8-byte LE `tokenAmount` so sCrypt Script numbers never overflow negative.
 */

import { API_NET, API_TARGET, FtManager, mvc } from 'meta-contract';
import { getMvcWalletFromPath } from '../services/metabotWalletService';
import {
  attachMvcFundingSignatureContext,
  selectMvcFundingUtxos,
} from '../services/tokenTransferAdapters';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ftProto = require('meta-contract/dist/mcp02/contract-proto/token.proto');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TokenGenesisFactory } = require('meta-contract/dist/mcp02/contract-factory/tokenGenesis');

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";
const METALET_HOST = 'https://www.metalet.space';
const APIMVC_HOST = 'https://api.microvisionchain.com/open-api-mvc';

export const MAX_MCP02_TOKEN_AMOUNT_BASE = 9_223_372_036_854_775_807n;
export const MAX_MCP02_TOKEN_NAME_BYTES = 40;
export const MAX_MCP02_TOKEN_SYMBOL_BYTES = 10;
export const MAX_MCP02_DECIMALS = 18;

export interface RawMvcFundingCandidate {
  txId: string;
  outputIndex: number;
  satoshis: number;
  height?: number;
}

export interface KnownGenesisUtxoHint {
  txId: string;
  outputIndex: number;
  txHex?: string;
}

export interface MvcFtIssueWorkerIoDeps {
  fetchFundingUtxos?: (address: string) => Promise<RawMvcFundingCandidate[]>;
  fetchRawTxHex?: (txId: string) => Promise<string>;
  fetchGenesisUnspents?: (params: {
    codehash: string;
    genesis: string;
    address: string;
  }) => Promise<Array<{ txId: string; outputIndex: number }>>;
}

export interface MvcChangeUtxoSummary {
  txId: string;
  outputIndex: number;
  satoshis: number;
  address: string;
  height: number;
}

export interface BuildMvcFtIssueLocalParams {
  senderWif: string;
  senderAddress: string;
  tokenName: string;
  tokenSymbol: string;
  decimals: number;
  initialSupplyBase: string;
  receiverAddress?: string;
  allowIncreaseMints?: boolean;
  feeRate: number;
  excludeOutpoints?: string[];
  preferredFundingUtxos?: RawMvcFundingCandidate[];
  preferredFundingRawTxs?: Record<string, string>;
}

export interface BuildMvcFtIssueLocalResult {
  codehash: string;
  genesis: string;
  sensibleId: string;
  assetKey: string;
  issuerAddress: string;
  receiverAddress: string;
  tokenName: string;
  tokenSymbol: string;
  decimals: number;
  initialSupplyBase: string;
  allowIncreaseMints: boolean;
  genesisTxHex: string;
  genesisTxId: string;
  genesisFeeSats: number;
  mintTxHex: string | null;
  mintTxId: string | null;
  mintFeeSats: number;
  minerFeeSats: number;
  lockedDustSats: number;
  totalFeeSats: number;
  tokenOutputIndex: number | null;
  continuationGenesisOutpoint: string | null;
  continuationGenesisTxHex: string | null;
  spentOutpoints: string[];
  changeOutpoint: string | null;
  changeUtxo: MvcChangeUtxoSummary | null;
}

export interface BuildMvcFtMintLocalParams {
  senderWif: string;
  senderAddress: string;
  sensibleId: string;
  amountBase: string;
  receiverAddress?: string;
  allowIncreaseMints?: boolean;
  feeRate: number;
  excludeOutpoints?: string[];
  preferredFundingUtxos?: RawMvcFundingCandidate[];
  preferredFundingRawTxs?: Record<string, string>;
  knownGenesisUtxo?: KnownGenesisUtxoHint;
  genesisTxHexHint?: string;
}

export interface BuildMvcFtMintLocalResult {
  codehash: string;
  genesis: string;
  sensibleId: string;
  assetKey: string;
  issuerAddress: string;
  receiverAddress: string;
  tokenName: string;
  tokenSymbol: string;
  decimals: number;
  amountBase: string;
  allowIncreaseMints: boolean;
  mintTxHex: string;
  mintTxId: string;
  mintFeeSats: number;
  minerFeeSats: number;
  lockedDustSats: number;
  totalFeeSats: number;
  tokenOutputIndex: number;
  continuationGenesisOutpoint: string | null;
  continuationGenesisTxHex: string | null;
  spentOutpoints: string[];
  changeOutpoint: string | null;
  changeUtxo: MvcChangeUtxoSummary | null;
}

function logStep(message: string, details?: Record<string, unknown>): void {
  try {
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    process.stderr.write(`[buildMvcFtIssueRawTxWorker] ${message}${suffix}\n`);
  } catch {
    // ignore logging failures
  }
}

function getMessage(err: unknown): string {
  if (err != null && typeof err === 'object' && 'message' in err && typeof (err as Error).message === 'string') {
    return (err as Error).message;
  }
  return String(err);
}

function isInsufficientMvcFundingError(err: unknown): boolean {
  const normalized = getMessage(err).toLowerCase();
  return (
    normalized.includes('insufficient balance') ||
    normalized.includes('not enough balance') ||
    normalized.includes('take more than') ||
    normalized.includes('余额不足')
  );
}

function normalizeExcludeOutpoints(input: unknown): Set<string> {
  if (!Array.isArray(input)) return new Set();
  return new Set(
    input
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((value) => /^[0-9a-f]{64}:\d+$/.test(value)),
  );
}

function assertValidMvcAddress(address: string, label: string): string {
  const clean = String(address || '').trim();
  if (!clean) {
    throw new Error(`${label} is required`);
  }
  try {
    // Validate base58check livenet MVC address
    const parsed = new mvc.Address(clean, API_NET.MAIN);
    return parsed.toString();
  } catch {
    throw new Error(`Invalid MVC address for ${label}: ${clean}`);
  }
}

export function parseSensibleIdHex(sensibleIdRaw: string): {
  sensibleId: string;
  genesisTxId: string;
  genesisOutputIndex: number;
} {
  const clean = String(sensibleIdRaw || '').trim().toLowerCase();
  if (!/^[0-9a-f]{72}$/.test(clean)) {
    throw new Error('sensibleId must be a 72-character hex outpoint (<32B-txid-LE><4B-vout-LE>)');
  }
  const buf = Buffer.from(clean, 'hex');
  const genesisTxId = Buffer.from(buf.subarray(0, 32)).reverse().toString('hex');
  const genesisOutputIndex = buf.readUInt32LE(32);
  return { sensibleId: clean, genesisTxId, genesisOutputIndex };
}

async function defaultFetchFundingUtxos(address: string): Promise<RawMvcFundingCandidate[]> {
  const all: RawMvcFundingCandidate[] = [];
  let flag: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const params = new URLSearchParams({
      address,
      net: 'livenet',
      ...(flag ? { flag } : {}),
    });
    const res = await fetch(`${METALET_HOST}/wallet-api/v4/mvc/address/utxo-list?${params}`);
    if (!res.ok) {
      throw new Error(`Failed to fetch MVC UTXOs (HTTP ${res.status})`);
    }
    const json = (await res.json()) as {
      data?: {
        list?: Array<{
          txid?: string;
          outIndex?: number | string;
          value?: number | string;
          height?: number | string;
          flag?: string;
        }>;
      };
    };
    const list = json?.data?.list ?? [];
    if (!list.length) break;
    for (const row of list) {
      const txId = String(row.txid || '').trim().toLowerCase();
      const outputIndex = Number(row.outIndex);
      const satoshis = Math.round(Number(row.value || 0));
      const height = Number(row.height ?? 0);
      if (/^[0-9a-f]{64}$/.test(txId) && Number.isInteger(outputIndex) && outputIndex >= 0 && satoshis > 600) {
        all.push({ txId, outputIndex, satoshis, height });
      }
    }
    const nextFlag = typeof list[list.length - 1]?.flag === 'string' ? String(list[list.length - 1].flag) : undefined;
    if (!nextFlag || nextFlag === '0' || nextFlag === flag) break;
    flag = nextFlag;
  }
  return all;
}

async function defaultFetchRawTxHex(txId: string): Promise<string> {
  const clean = String(txId || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(`Invalid txId for raw tx lookup: ${txId}`);
  }
  const metaletUrl = `${METALET_HOST}/wallet-api/v4/mvc/tx/raw?txId=${clean}&net=mainnet`;
  try {
    const res = await fetch(metaletUrl, { headers: { accept: 'application/json' } });
    if (res.ok) {
      const json = (await res.json()) as { data?: { hex?: string } };
      const hex = String(json?.data?.hex || '').trim().toLowerCase();
      if (/^[0-9a-f]+$/.test(hex) && hex.length >= 20) {
        return hex;
      }
    }
  } catch {
    // fall through to APIMVC
  }
  const apiMvcUrl = `${APIMVC_HOST}/tx/${clean}/raw`;
  const res2 = await fetch(apiMvcUrl, { headers: { accept: 'application/json' } });
  if (!res2.ok) {
    throw new Error(`Unable to fetch raw MVC transaction ${clean} (HTTP ${res2.status})`);
  }
  const json2 = (await res2.json()) as { hex?: string; data?: { hex?: string } };
  const hex2 = String(json2?.hex || json2?.data?.hex || '').trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex2) || hex2.length < 20) {
    throw new Error(`Empty raw MVC transaction payload for ${clean}`);
  }
  return hex2;
}

async function defaultFetchGenesisUnspents(params: {
  codehash: string;
  genesis: string;
  address: string;
}): Promise<Array<{ txId: string; outputIndex: number }>> {
  const url =
    `${APIMVC_HOST}/contract/ft/address/${encodeURIComponent(params.address)}/utxo` +
    `?codeHash=${encodeURIComponent(params.codehash)}&genesis=${encodeURIComponent(params.genesis)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    return [];
  }
  const rows = (await res.json()) as Array<{ txid?: string; txId?: string; txIndex?: number; outputIndex?: number }>;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      txId: String(row.txId ?? row.txid ?? '').trim().toLowerCase(),
      outputIndex: Number(row.outputIndex ?? row.txIndex ?? -1),
    }))
    .filter((row) => /^[0-9a-f]{64}$/.test(row.txId) && Number.isInteger(row.outputIndex) && row.outputIndex >= 0);
}

function sumOutputsSatoshis(tx: any): number {
  return (tx.outputs as Array<{ satoshis: number }>).reduce(
    (acc, out) => acc + Number(out.satoshis || 0),
    0,
  );
}

function extractTxSpentOutpoints(tx: any): string[] {
  return (tx.inputs as Array<{ prevTxId: Buffer; outputIndex: number }>).map(
    (input) => `${input.prevTxId.toString('hex').toLowerCase()}:${Number(input.outputIndex)}`,
  );
}

function findP2pkhChangeOutpoint(tx: any, txid: string, expectedAddress: string): {
  outpoint: string | null;
  vout: number;
  satoshis: number;
} {
  for (let idx = tx.outputs.length - 1; idx >= 0; idx -= 1) {
    const out = tx.outputs[idx];
    try {
      const outAddr = out.script.toAddress(API_NET.MAIN).toString();
      if (outAddr === expectedAddress && Number(out.satoshis) > 0) {
        return {
          outpoint: `${txid}:${idx}`,
          vout: idx,
          satoshis: Number(out.satoshis),
        };
      }
    } catch {
      // contract or OP_RETURN script, keep scanning backwards
    }
  }
  return { outpoint: null, vout: -1, satoshis: 0 };
}

export async function buildMvcFtIssueRawTxLocally(
  params: BuildMvcFtIssueLocalParams,
  ioDeps: MvcFtIssueWorkerIoDeps = {},
): Promise<BuildMvcFtIssueLocalResult> {
  const senderWif = String(params.senderWif || '').trim();
  if (!senderWif) throw new Error('senderWif is required');
  const senderAddress = assertValidMvcAddress(params.senderAddress, 'senderAddress');
  const receiverAddress = assertValidMvcAddress(params.receiverAddress || senderAddress, 'receiverAddress');

  const tokenName = String(params.tokenName ?? '').trim();
  if (!tokenName || Buffer.byteLength(tokenName, 'utf8') > MAX_MCP02_TOKEN_NAME_BYTES) {
    throw new Error(`tokenName must be 1..${MAX_MCP02_TOKEN_NAME_BYTES} UTF-8 bytes`);
  }
  const tokenSymbol = String(params.tokenSymbol ?? '').trim();
  if (!tokenSymbol || /\s/.test(tokenSymbol) || Buffer.byteLength(tokenSymbol, 'utf8') > MAX_MCP02_TOKEN_SYMBOL_BYTES) {
    throw new Error(`tokenSymbol must be 1..${MAX_MCP02_TOKEN_SYMBOL_BYTES} UTF-8 bytes without whitespace`);
  }
  const decimals = Number(params.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_MCP02_DECIMALS) {
    throw new Error(`decimals must be an integer between 0 and ${MAX_MCP02_DECIMALS}`);
  }
  const feeRate = Number(params.feeRate);
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    throw new Error('feeRate must be a positive number');
  }

  const supplyStr = String(params.initialSupplyBase ?? '').trim();
  if (!/^\d+$/.test(supplyStr)) {
    throw new Error('initialSupplyBase must be a non-negative integer string');
  }
  const supplyBig = BigInt(supplyStr);
  if (supplyBig > MAX_MCP02_TOKEN_AMOUNT_BASE) {
    throw new Error(
      `initialSupplyBase (${supplyStr}) exceeds MCP02 64-bit signed integer limit (${MAX_MCP02_TOKEN_AMOUNT_BASE.toString()})`,
    );
  }
  const allowIncreaseMints = params.allowIncreaseMints === true;
  if (supplyBig === 0n && !allowIncreaseMints) {
    throw new Error('Fixed-supply token (allowIncreaseMints=false) requires initialSupplyBase > 0');
  }

  const fetchFundingUtxos = ioDeps.fetchFundingUtxos ?? defaultFetchFundingUtxos;
  const fetchRawTxHex = ioDeps.fetchRawTxHex ?? defaultFetchRawTxHex;
  const excludeOutpoints = normalizeExcludeOutpoints(params.excludeOutpoints);

  const fetchedCandidates = await fetchFundingUtxos(senderAddress);
  const combinedCandidates = [
    ...(Array.isArray(params.preferredFundingUtxos) ? params.preferredFundingUtxos : []),
    ...fetchedCandidates,
  ];
  const seenCandidateKeys = new Set<string>();
  const filteredCandidates = combinedCandidates
    .filter((u) => {
      if (!u || typeof u !== 'object') return false;
      const key = `${String(u.txId || '').toLowerCase()}:${Number(u.outputIndex)}`;
      if (seenCandidateKeys.has(key)) return false;
      const valid =
        /^[0-9a-f]{64}$/i.test(String(u.txId || '')) &&
        Number.isInteger(Number(u.outputIndex)) &&
        Number(u.outputIndex) >= 0 &&
        Number(u.satoshis) > 600 &&
        !excludeOutpoints.has(key);
      if (valid) seenCandidateKeys.add(key);
      return valid;
    })
    .map((u) => ({
      txId: String(u.txId).toLowerCase(),
      outputIndex: Number(u.outputIndex),
      satoshis: Number(u.satoshis),
      height: Number(u.height ?? 0),
      address: senderAddress,
    }));

  let utxos = attachMvcFundingSignatureContext(filteredCandidates, {
    senderWif,
    senderAddress,
  });
  utxos = selectMvcFundingUtxos(utxos);
  if (utxos.length === 0) {
    throw new Error('INSUFFICIENT_SPACE_UTXO: No spendable MVC UTXOs (> 600 sats) available in issuer wallet');
  }

  const rawTxCache = new Map<string, string>();
  if (params.preferredFundingRawTxs && typeof params.preferredFundingRawTxs === 'object') {
    for (const [k, v] of Object.entries(params.preferredFundingRawTxs)) {
      if (/^[0-9a-f]{64}$/i.test(k) && typeof v === 'string' && /^[0-9a-f]+$/i.test(v.trim())) {
        rawTxCache.set(k.toLowerCase(), v.trim().toLowerCase());
      }
    }
  }
  const getCachedRawTxHex = async (txId: string): Promise<string> => {
    const key = txId.toLowerCase();
    const hit = rawTxCache.get(key);
    if (hit) return hit;
    const fetched = (await fetchRawTxHex(key)).toLowerCase();
    rawTxCache.set(key, fetched);
    return fetched;
  };

  let lastBuildError: unknown = null;
  for (let prefixSize = 1; prefixSize <= utxos.length; prefixSize += 1) {
    const genesisFundingSlice = utxos.slice(0, prefixSize);
    try {
      // Pre-warm input[0] prev raw tx needed by TokenGenesis input/output proofs during mint
      await getCachedRawTxHex(genesisFundingSlice[0].txId);

      const ftManager = new FtManager({
        network: API_NET.MAIN,
        apiTarget: API_TARGET.APIMVC,
        purse: senderWif,
        feeb: feeRate,
        debug: true,
      });
      ftManager.api.getRawTxData = async (txId: string) => getCachedRawTxHex(txId);

      const genesisRes = await ftManager.genesis({
        version: 2,
        tokenName,
        tokenSymbol,
        decimalNum: decimals,
        genesisWif: senderWif,
        utxos: genesisFundingSlice,
        changeAddress: senderAddress,
        noBroadcast: true,
      });

      const genesisInputSats = genesisFundingSlice.reduce((sum, u) => sum + Number(u.satoshis), 0);
      const genesisOutputSats = sumOutputsSatoshis(genesisRes.tx);
      const genesisFeeSats = Math.max(0, genesisInputSats - genesisOutputSats);
      const genesisContractSats = Number(genesisRes.tx.outputs[0]?.satoshis || 0);
      const genesisChange = findP2pkhChangeOutpoint(genesisRes.tx, genesisRes.txid, senderAddress);

      const codehash = genesisRes.codehash.toLowerCase();
      const genesis = genesisRes.genesis.toLowerCase();
      const sensibleId = genesisRes.sensibleId.toLowerCase();
      const assetKey = `mvc-ft:${codehash}:${genesis}`;

      if (supplyBig === 0n) {
        const spentOutpoints = extractTxSpentOutpoints(genesisRes.tx);
        return {
          codehash,
          genesis,
          sensibleId,
          assetKey,
          issuerAddress: senderAddress,
          receiverAddress,
          tokenName,
          tokenSymbol,
          decimals,
          initialSupplyBase: '0',
          allowIncreaseMints: true,
          genesisTxHex: genesisRes.txHex,
          genesisTxId: genesisRes.txid,
          genesisFeeSats,
          mintTxHex: null,
          mintTxId: null,
          mintFeeSats: 0,
          minerFeeSats: genesisFeeSats,
          lockedDustSats: genesisContractSats,
          totalFeeSats: genesisFeeSats + genesisContractSats,
          tokenOutputIndex: null,
          continuationGenesisOutpoint: `${genesisRes.txid}:0`,
          continuationGenesisTxHex: genesisRes.txHex,
          spentOutpoints,
          changeOutpoint: genesisChange.outpoint,
          changeUtxo:
            genesisChange.vout >= 0 && genesisChange.satoshis > 600
              ? {
                  txId: genesisRes.txid.toLowerCase(),
                  outputIndex: genesisChange.vout,
                  satoshis: genesisChange.satoshis,
                  address: senderAddress,
                  height: -1,
                }
              : null,
        };
      }

      // Chain 0-conf initial mint off genesisRes
      rawTxCache.set(genesisRes.txid.toLowerCase(), genesisRes.txHex.toLowerCase());
      ftManager.api.getFungibleTokenUnspents = (async () => [
        { txId: genesisRes.txid, outputIndex: 0 },
      ]) as any;

      const remainingWalletUtxos = utxos.slice(prefixSize);
      const mintCandidates: Array<{
        txId: string;
        outputIndex: number;
        satoshis: number;
        wif: string;
        address: string;
      }> = [];
      if (genesisChange.vout >= 0 && genesisChange.satoshis >= 600) {
        mintCandidates.push({
          txId: genesisRes.txid,
          outputIndex: genesisChange.vout,
          satoshis: genesisChange.satoshis,
          wif: senderWif,
          address: senderAddress,
        });
      }
      for (const rem of remainingWalletUtxos) {
        mintCandidates.push({
          txId: rem.txId,
          outputIndex: rem.outputIndex,
          satoshis: rem.satoshis,
          wif: senderWif,
          address: senderAddress,
        });
      }
      if (mintCandidates.length === 0) {
        if (prefixSize < utxos.length) continue;
        throw new Error('Insufficient SPACE balance to fund initial token mint after genesis');
      }

      let mintRes: Awaited<ReturnType<typeof ftManager.mint>> | null = null;
      let pickedMintFunding = mintCandidates;
      let lastMintErr: unknown = null;
      for (let mPrefix = 1; mPrefix <= mintCandidates.length; mPrefix += 1) {
        const mSlice = mintCandidates.slice(0, mPrefix);
        try {
          mintRes = await ftManager.mint({
            version: 2,
            sensibleId: genesisRes.sensibleId,
            genesisWif: senderWif,
            receiverAddress,
            tokenAmount: supplyBig.toString(),
            allowIncreaseMints,
            utxos: mSlice,
            changeAddress: senderAddress,
            noBroadcast: true,
          });
          pickedMintFunding = mSlice;
          break;
        } catch (mErr) {
          lastMintErr = mErr;
          if (mPrefix < mintCandidates.length && isInsufficientMvcFundingError(mErr)) {
            continue;
          }
          throw mErr;
        }
      }

      if (!mintRes) {
        throw lastMintErr instanceof Error ? lastMintErr : new Error(getMessage(lastMintErr || 'Failed to build initial mint tx'));
      }

      const mintP2pkhInputSats = pickedMintFunding.reduce((sum, u) => sum + Number(u.satoshis), 0);
      const mintTotalInputSats = genesisContractSats + mintP2pkhInputSats;
      const mintOutputSats = sumOutputsSatoshis(mintRes.tx);
      const mintFeeSats = Math.max(0, mintTotalInputSats - mintOutputSats);
      const minerFeeSats = genesisFeeSats + mintFeeSats;

      const tokenOutputIndex = allowIncreaseMints ? 1 : 0;
      const tokenDustSats = Number(mintRes.tx.outputs[tokenOutputIndex]?.satoshis || 0);
      const continuationGenesisSats = allowIncreaseMints ? Number(mintRes.tx.outputs[0]?.satoshis || 0) : 0;
      const lockedDustSats = tokenDustSats + continuationGenesisSats;
      const totalFeeSats = minerFeeSats + lockedDustSats;

      const mintChange = findP2pkhChangeOutpoint(mintRes.tx, mintRes.txid, senderAddress);
      const walletOutpointsSpent = Array.from(
        new Set([
          ...extractTxSpentOutpoints(genesisRes.tx),
          ...extractTxSpentOutpoints(mintRes.tx).filter((op) => !op.startsWith(`${genesisRes.txid.toLowerCase()}:`)),
        ]),
      );

      logStep('Built MVC FT genesis + initial mint bundle locally', {
        assetKey,
        genesisTxId: genesisRes.txid,
        mintTxId: mintRes.txid,
        minerFeeSats,
        lockedDustSats,
        totalFeeSats,
      });

      return {
        codehash,
        genesis,
        sensibleId,
        assetKey,
        issuerAddress: senderAddress,
        receiverAddress,
        tokenName,
        tokenSymbol,
        decimals,
        initialSupplyBase: supplyBig.toString(),
        allowIncreaseMints,
        genesisTxHex: genesisRes.txHex,
        genesisTxId: genesisRes.txid,
        genesisFeeSats,
        mintTxHex: mintRes.txHex,
        mintTxId: mintRes.txid,
        mintFeeSats,
        minerFeeSats,
        lockedDustSats,
        totalFeeSats,
        tokenOutputIndex,
        continuationGenesisOutpoint: allowIncreaseMints ? `${mintRes.txid}:0` : null,
        continuationGenesisTxHex: allowIncreaseMints ? mintRes.txHex : null,
        spentOutpoints: walletOutpointsSpent,
        changeOutpoint: mintChange.outpoint,
        changeUtxo:
          mintChange.vout >= 0 && mintChange.satoshis > 600
            ? {
                txId: mintRes.txid.toLowerCase(),
                outputIndex: mintChange.vout,
                satoshis: mintChange.satoshis,
                address: senderAddress,
                height: -1,
              }
            : null,
      };
    } catch (err) {
      lastBuildError = err;
      if (prefixSize < utxos.length && isInsufficientMvcFundingError(err)) {
        continue;
      }
      throw err;
    }
  }

  throw lastBuildError instanceof Error
    ? lastBuildError
    : new Error(getMessage(lastBuildError || 'Failed to build MVC FT genesis + mint transactions'));
}

export async function buildMvcFtMintRawTxLocally(
  params: BuildMvcFtMintLocalParams,
  ioDeps: MvcFtIssueWorkerIoDeps = {},
): Promise<BuildMvcFtMintLocalResult> {
  const senderWif = String(params.senderWif || '').trim();
  if (!senderWif) throw new Error('senderWif is required');
  const senderAddress = assertValidMvcAddress(params.senderAddress, 'senderAddress');
  const receiverAddress = assertValidMvcAddress(params.receiverAddress || senderAddress, 'receiverAddress');
  const { sensibleId, genesisTxId, genesisOutputIndex } = parseSensibleIdHex(params.sensibleId);

  const amountStr = String(params.amountBase ?? '').trim();
  if (!/^\d+$/.test(amountStr)) {
    throw new Error('amountBase must be a positive integer string');
  }
  const amountBig = BigInt(amountStr);
  if (amountBig <= 0n) {
    throw new Error('amountBase must be greater than 0');
  }
  if (amountBig > MAX_MCP02_TOKEN_AMOUNT_BASE) {
    throw new Error(
      `amountBase (${amountStr}) exceeds MCP02 64-bit signed integer limit (${MAX_MCP02_TOKEN_AMOUNT_BASE.toString()})`,
    );
  }
  const feeRate = Number(params.feeRate);
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    throw new Error('feeRate must be a positive number');
  }
  const allowIncreaseMints = params.allowIncreaseMints !== false;

  const fetchFundingUtxos = ioDeps.fetchFundingUtxos ?? defaultFetchFundingUtxos;
  const fetchRawTxHex = ioDeps.fetchRawTxHex ?? defaultFetchRawTxHex;
  const fetchGenesisUnspents = ioDeps.fetchGenesisUnspents ?? defaultFetchGenesisUnspents;
  const excludeOutpoints = normalizeExcludeOutpoints(params.excludeOutpoints);

  const rawTxCache = new Map<string, string>();
  if (params.preferredFundingRawTxs && typeof params.preferredFundingRawTxs === 'object') {
    for (const [k, v] of Object.entries(params.preferredFundingRawTxs)) {
      if (/^[0-9a-f]{64}$/i.test(k) && typeof v === 'string' && /^[0-9a-f]+$/i.test(v.trim())) {
        rawTxCache.set(k.toLowerCase(), v.trim().toLowerCase());
      }
    }
  }
  if (params.genesisTxHexHint && /^[0-9a-f]+$/i.test(params.genesisTxHexHint.trim())) {
    rawTxCache.set(genesisTxId.toLowerCase(), params.genesisTxHexHint.trim().toLowerCase());
  }
  if (
    params.knownGenesisUtxo?.txId &&
    params.knownGenesisUtxo?.txHex &&
    /^[0-9a-f]{64}$/i.test(params.knownGenesisUtxo.txId) &&
    /^[0-9a-f]+$/i.test(params.knownGenesisUtxo.txHex)
  ) {
    rawTxCache.set(params.knownGenesisUtxo.txId.trim().toLowerCase(), params.knownGenesisUtxo.txHex.trim().toLowerCase());
  }

  const getCachedRawTxHex = async (txId: string): Promise<string> => {
    const key = txId.toLowerCase();
    const hit = rawTxCache.get(key);
    if (hit) return hit;
    const fetched = (await fetchRawTxHex(key)).toLowerCase();
    rawTxCache.set(key, fetched);
    return fetched;
  };

  // Resolve active unspent TokenGenesis contract UTXO (indexer first, local 0-conf hint fallback)
  const firstGenesisTxHex = await getCachedRawTxHex(genesisTxId);
  const firstGenesisTx = new mvc.Transaction(firstGenesisTxHex);
  const firstGenesisOut = firstGenesisTx.outputs[genesisOutputIndex];
  if (!firstGenesisOut) {
    throw new Error(`Invalid sensibleId: output ${genesisOutputIndex} missing on genesis tx ${genesisTxId}`);
  }
  const genesisContract = TokenGenesisFactory.createContract();
  const genesisContractCodeHash = String(genesisContract.getCodeHash()).toLowerCase();
  const scriptBuffer = firstGenesisOut.script.toBuffer();
  const originGenesis = String(ftProto.getQueryGenesis(scriptBuffer)).toLowerCase();

  let activeGenesisUtxo: { txId: string; outputIndex: number } | null = null;
  const originMatches = await fetchGenesisUnspents({
    codehash: genesisContractCodeHash,
    genesis: originGenesis,
    address: senderAddress,
  });
  const directOrigin = originMatches.find(
    (u) => u.txId.toLowerCase() === genesisTxId.toLowerCase() && u.outputIndex === genesisOutputIndex,
  );
  if (directOrigin) {
    activeGenesisUtxo = directOrigin;
  } else {
    const dataPartObj = ftProto.parseDataPart(scriptBuffer);
    dataPartObj.sensibleID = { txid: genesisTxId, index: genesisOutputIndex };
    const updatedScriptBuf = ftProto.updateScript(scriptBuffer, dataPartObj);
    const issueGenesis = String(ftProto.getQueryGenesis(updatedScriptBuf)).toLowerCase();
    const issueMatches = await fetchGenesisUnspents({
      codehash: genesisContractCodeHash,
      genesis: issueGenesis,
      address: senderAddress,
    });
    if (issueMatches.length > 0) {
      activeGenesisUtxo = issueMatches[0];
    }
  }

  if (!activeGenesisUtxo && params.knownGenesisUtxo) {
    const hintTxId = String(params.knownGenesisUtxo.txId || '').trim().toLowerCase();
    const hintVout = Number(params.knownGenesisUtxo.outputIndex);
    if (/^[0-9a-f]{64}$/.test(hintTxId) && Number.isInteger(hintVout) && hintVout >= 0) {
      activeGenesisUtxo = { txId: hintTxId, outputIndex: hintVout };
    }
  }

  if (!activeGenesisUtxo) {
    throw new Error(
      'FT_SUPPLY_FIXED_OR_UNAVAILABLE: No unspent TokenGenesis UTXO found for this token (supply is permanently fixed or mint authority is held by another wallet)',
    );
  }

  // Ensure both activeGenesisTx and its input[0] parent raw tx are cached for TokenGenesis proof construction
  const activeGenesisTxHex = await getCachedRawTxHex(activeGenesisUtxo.txId);
  const activeGenesisTx = new mvc.Transaction(activeGenesisTxHex);
  const activeGenesisContractSats = Number(activeGenesisTx.outputs[activeGenesisUtxo.outputIndex]?.satoshis || 0);
  const preTxId = activeGenesisTx.inputs[0]?.prevTxId?.toString('hex');
  if (preTxId) {
    await getCachedRawTxHex(preTxId);
  }

  // Exclude the genesis contract outpoint itself from P2PKH funding candidates
  excludeOutpoints.add(`${activeGenesisUtxo.txId.toLowerCase()}:${activeGenesisUtxo.outputIndex}`);

  const fetchedCandidates = await fetchFundingUtxos(senderAddress);
  const combinedCandidates = [
    ...(Array.isArray(params.preferredFundingUtxos) ? params.preferredFundingUtxos : []),
    ...fetchedCandidates,
  ];
  const seenMintCandidateKeys = new Set<string>();
  const filteredCandidates = combinedCandidates
    .filter((u) => {
      if (!u || typeof u !== 'object') return false;
      const key = `${String(u.txId || '').toLowerCase()}:${Number(u.outputIndex)}`;
      if (seenMintCandidateKeys.has(key)) return false;
      const valid =
        /^[0-9a-f]{64}$/i.test(String(u.txId || '')) &&
        Number.isInteger(Number(u.outputIndex)) &&
        Number(u.outputIndex) >= 0 &&
        Number(u.satoshis) > 600 &&
        !excludeOutpoints.has(key);
      if (valid) seenMintCandidateKeys.add(key);
      return valid;
    })
    .map((u) => ({
      txId: String(u.txId).toLowerCase(),
      outputIndex: Number(u.outputIndex),
      satoshis: Number(u.satoshis),
      height: Number(u.height ?? 0),
      address: senderAddress,
    }));

  let utxos = attachMvcFundingSignatureContext(filteredCandidates, {
    senderWif,
    senderAddress,
  });
  utxos = selectMvcFundingUtxos(utxos);
  if (utxos.length === 0) {
    throw new Error('INSUFFICIENT_SPACE_UTXO: No spendable MVC UTXOs (> 600 sats) available in issuer wallet');
  }

  const ftManager = new FtManager({
    network: API_NET.MAIN,
    apiTarget: API_TARGET.APIMVC,
    purse: senderWif,
    feeb: feeRate,
    debug: true,
  });
  ftManager.api.getRawTxData = async (txId: string) => getCachedRawTxHex(txId);
  ftManager.api.getFungibleTokenUnspents = (async () => [activeGenesisUtxo!]) as any;

  let mintRes: Awaited<ReturnType<typeof ftManager.mint>> | null = null;
  let pickedFunding = utxos;
  let lastErr: unknown = null;
  for (let prefixSize = 1; prefixSize <= utxos.length; prefixSize += 1) {
    const slice = utxos.slice(0, prefixSize);
    try {
      mintRes = await ftManager.mint({
        version: 2,
        sensibleId,
        genesisWif: senderWif,
        receiverAddress,
        tokenAmount: amountBig.toString(),
        allowIncreaseMints,
        utxos: slice,
        changeAddress: senderAddress,
        noBroadcast: true,
      });
      pickedFunding = slice;
      break;
    } catch (err) {
      lastErr = err;
      if (prefixSize < utxos.length && isInsufficientMvcFundingError(err)) {
        continue;
      }
      throw err;
    }
  }

  if (!mintRes) {
    throw lastErr instanceof Error ? lastErr : new Error(getMessage(lastErr || 'Failed to build MVC FT mint tx'));
  }

  const tokenOutputIndex = allowIncreaseMints ? 1 : 0;
  const tokenOut = mintRes.tx.outputs[tokenOutputIndex];
  const tokenScriptBuf = tokenOut.script.toBuffer();
  const codehash = String(ftProto.getQueryCodehash(tokenScriptBuf)).toLowerCase();
  const genesis = String(ftProto.getQueryGenesis(tokenScriptBuf)).toLowerCase();
  const assetKey = `mvc-ft:${codehash}:${genesis}`;
  const decimals = Number(ftProto.getDecimalNum(tokenScriptBuf));
  const tokenName = String(ftProto.getTokenName(tokenScriptBuf) || '').replace(/\0+$/g, '');
  const tokenSymbol = String(ftProto.getTokenSymbol(tokenScriptBuf) || '').replace(/\0+$/g, '');

  const p2pkhInputSats = pickedFunding.reduce((sum, u) => sum + Number(u.satoshis), 0);
  const totalInputSats = activeGenesisContractSats + p2pkhInputSats;
  const totalOutputSats = sumOutputsSatoshis(mintRes.tx);
  const mintFeeSats = Math.max(0, totalInputSats - totalOutputSats);
  const tokenDustSats = Number(tokenOut?.satoshis || 0);
  const continuationGenesisSats = allowIncreaseMints ? Number(mintRes.tx.outputs[0]?.satoshis || 0) : 0;
  const lockedDustSats = Math.max(0, tokenDustSats + continuationGenesisSats - activeGenesisContractSats);
  const totalFeeSats = mintFeeSats + lockedDustSats;

  const mintChange = findP2pkhChangeOutpoint(mintRes.tx, mintRes.txid, senderAddress);
  const spentOutpoints = extractTxSpentOutpoints(mintRes.tx);

  logStep('Built MVC FT follow-up mint raw tx locally', {
    assetKey,
    mintTxId: mintRes.txid,
    mintFeeSats,
    totalFeeSats,
    allowIncreaseMints,
  });

  return {
    codehash,
    genesis,
    sensibleId,
    assetKey,
    issuerAddress: senderAddress,
    receiverAddress,
    tokenName,
    tokenSymbol,
    decimals,
    amountBase: amountBig.toString(),
    allowIncreaseMints,
    mintTxHex: mintRes.txHex,
    mintTxId: mintRes.txid,
    mintFeeSats,
    minerFeeSats: mintFeeSats,
    lockedDustSats,
    totalFeeSats,
    tokenOutputIndex,
    continuationGenesisOutpoint: allowIncreaseMints ? `${mintRes.txid}:0` : null,
    continuationGenesisTxHex: allowIncreaseMints ? mintRes.txHex : null,
    spentOutpoints,
    changeOutpoint: mintChange.outpoint,
    changeUtxo:
      mintChange.vout >= 0 && mintChange.satoshis > 600
        ? {
            txId: mintRes.txid.toLowerCase(),
            outputIndex: mintChange.vout,
            satoshis: mintChange.satoshis,
            address: senderAddress,
            height: -1,
          }
        : null,
  };
}

async function main(): Promise<void> {
  const mnemonic = process.env.IDBOTS_METABOT_MNEMONIC?.trim();
  const pathStr = (process.env.IDBOTS_METABOT_PATH || DEFAULT_PATH).trim();
  if (!mnemonic) {
    console.log(JSON.stringify({ success: false, error: 'IDBOTS_METABOT_MNEMONIC required' }));
    process.exit(1);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
  const action = String(payload.action || 'issue').trim();

  const mvcWallet = await getMvcWalletFromPath(mnemonic, pathStr);
  const senderWif = mvcWallet.getPrivateKey();
  const senderAddress = mvcWallet.getAddress();

  if (action === 'issue') {
    const result = await buildMvcFtIssueRawTxLocally({
      senderWif,
      senderAddress,
      tokenName: String(payload.tokenName ?? ''),
      tokenSymbol: String(payload.tokenSymbol ?? ''),
      decimals: Number(payload.decimals ?? 8),
      initialSupplyBase: String(payload.initialSupplyBase ?? ''),
      receiverAddress: typeof payload.receiverAddress === 'string' && payload.receiverAddress.trim()
        ? payload.receiverAddress.trim()
        : senderAddress,
      allowIncreaseMints: payload.allowIncreaseMints === true,
      feeRate: Number(payload.feeRate),
      excludeOutpoints: Array.isArray(payload.excludeOutpoints) ? (payload.excludeOutpoints as string[]) : [],
      preferredFundingUtxos: Array.isArray(payload.preferredFundingUtxos)
        ? (payload.preferredFundingUtxos as RawMvcFundingCandidate[])
        : [],
      preferredFundingRawTxs:
        payload.preferredFundingRawTxs && typeof payload.preferredFundingRawTxs === 'object'
          ? (payload.preferredFundingRawTxs as Record<string, string>)
          : undefined,
    });
    console.log(JSON.stringify({ success: true, ...result }));
    return;
  }

  if (action === 'mint') {
    const knownGenesisRaw = payload.knownGenesisUtxo as KnownGenesisUtxoHint | undefined;
    const result = await buildMvcFtMintRawTxLocally({
      senderWif,
      senderAddress,
      sensibleId: String(payload.sensibleId ?? ''),
      amountBase: String(payload.amountBase ?? ''),
      receiverAddress: typeof payload.receiverAddress === 'string' && payload.receiverAddress.trim()
        ? payload.receiverAddress.trim()
        : senderAddress,
      allowIncreaseMints: payload.allowIncreaseMints !== false,
      feeRate: Number(payload.feeRate),
      excludeOutpoints: Array.isArray(payload.excludeOutpoints) ? (payload.excludeOutpoints as string[]) : [],
      preferredFundingUtxos: Array.isArray(payload.preferredFundingUtxos)
        ? (payload.preferredFundingUtxos as RawMvcFundingCandidate[])
        : [],
      preferredFundingRawTxs:
        payload.preferredFundingRawTxs && typeof payload.preferredFundingRawTxs === 'object'
          ? (payload.preferredFundingRawTxs as Record<string, string>)
          : undefined,
      knownGenesisUtxo: knownGenesisRaw && typeof knownGenesisRaw === 'object' ? knownGenesisRaw : undefined,
      genesisTxHexHint: typeof payload.genesisTxHexHint === 'string' ? payload.genesisTxHexHint : undefined,
    });
    console.log(JSON.stringify({ success: true, ...result }));
    return;
  }

  console.log(JSON.stringify({ success: false, error: `Unsupported worker action: ${action}` }));
  process.exit(1);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.log(JSON.stringify({ success: false, error: getMessage(err) }));
    process.exit(1);
  });
}
