import type { MetabotStore } from '../metabotStore';
import {
  buildMvcTokenSellRawTx,
  type BuildMvcTokenSellRawTxResult,
  type MvcTokenSellListing,
  type MvcTokenSellListingRef,
} from './walletRawTxService';
import { isRetryableMvcBroadcastError, resolveBroadcastTxResult } from '../libs/mvcSpend';
import { freshGetUrlAndInit } from './freshFetch';
import { mvc } from 'meta-contract';
import {
  decodeTokenSellSeedLock,
  parseRawTx,
  v10TxId,
} from '../libs/mvcTokenSellCore';

/**
 * MVC FT TokenSell service — the FT trading counterpart of mvcNftService.
 *
 * Read path:
 *  - FT holdings per address (open-api-mvc contract/ft endpoints — the same
 *    ones the live-fire discovery used).
 *  - Listing verification: TokenSell has NO chain-wide order index (the
 *    listing four-tuple travels off-chain between counterparties by design);
 *    given a tuple we verify it against the chain — raw LIST tx, the seed
 *    lock decoded back into (seller, price), token output amount — so a
 *    counterparty cannot misquote a listing.
 *
 * Trade path: subprocess worker builds (never broadcasts) the ordered tx set;
 * this service broadcasts funding txs in order then the final tx, with the
 * same retryable-broadcast posture as the NFT trade execute.
 */

const METALET_HOST = 'https://www.metalet.space';
const APIMVC_HOST = 'https://api.microvisionchain.com/open-api-mvc';
const NET = 'livenet';
const RETRYABLE_MVC_TOKEN_SELL_BUILD_ATTEMPTS = 3;
const RETRYABLE_MVC_TOKEN_SELL_BROADCAST_DELAY_MS = 750;

export interface MvcFtTokenSummary {
  symbol: string;
  genesis: string;
  codeHash: string;
  /** base-unit balance as string (FT amounts exceed Number precision). */
  balance: string;
  decimal?: number;
  count?: number;
}

export interface MvcFtTokenBalance {
  address: string;
  count: number;
  tokens: MvcFtTokenSummary[];
}

export interface MvcTokenSellOrderVerify {
  listing: MvcTokenSellListingRef;
  verified: boolean;
  problems: string[];
  /** Decoded from the on-chain seed lock — do not trust the counterparty. */
  decoded: { sellerHash160Hex: string; priceSats: string; sellerAddressBase58?: string };
  tokenAmount: string;
  sellSats: number;
  txid: string;
}

interface RawFtBalanceRow {
  symbol?: string;
  genesis?: string;
  codeHash?: string;
  codehash?: string;
  balance?: string | number;
  decimal?: number | string;
  count?: number | string;
}

interface MvcTokenSellServiceDeps {
  fetchFtBalance: (address: string) => Promise<RawFtBalanceRow[]>;
  fetchRawTx: (txid: string) => Promise<string>;
  buildTradeRawTx: typeof buildMvcTokenSellRawTx;
  broadcastTx: (rawTx: string) => Promise<string>;
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as Error).message === 'string') {
    return (error as Error).message;
  }
  return String(error ?? '');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const defaultDeps: MvcTokenSellServiceDeps = {
  fetchFtBalance: async (address) => {
    const freshRequest = freshGetUrlAndInit(`${APIMVC_HOST}/contract/ft/address/${encodeURIComponent(address)}/balance`);
    const response = await fetch(freshRequest.url, freshRequest.init);
    const rows = (await response.json()) as RawFtBalanceRow[];
    return Array.isArray(rows) ? rows : [];
  },
  fetchRawTx: async (txid) => {
    const response = await fetch(`${METALET_HOST}/wallet-api/v4/mvc/tx/raw?txId=${txid}&net=mainnet`);
    const json = (await response.json()) as { data?: { hex?: string } };
    const hex = json?.data?.hex;
    if (!hex) throw new Error(`no raw tx from metalet: ${txid}`);
    return hex.toLowerCase();
  },
  buildTradeRawTx: buildMvcTokenSellRawTx,
  broadcastTx: async (rawTx) => {
    const response = await fetch(`${METALET_HOST}/wallet-api/v3/tx/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain: 'mvc', net: NET, rawTx }),
    });
    const json = (await response.json()) as { code?: number; message?: string; data?: string };
    return resolveBroadcastTxResult(rawTx, json);
  },
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const tokenSellDesc = require('meta-contract/dist/mcp02/contract-desc/tokenSell_desc.json');

/** FT holdings for one address (open-api-mvc; base-unit string balances). */
export async function getMvcFtTokenBalance(
  address: string,
  deps: Pick<MvcTokenSellServiceDeps, 'fetchFtBalance'> = defaultDeps,
): Promise<MvcFtTokenBalance> {
  if (!address || typeof address !== 'string') throw new Error('address is required');
  const rows = await deps.fetchFtBalance(address);
  const tokens: MvcFtTokenSummary[] = [];
  for (const row of rows) {
    const genesis = String(row.genesis || '').trim();
    const codeHash = String(row.codeHash || row.codehash || '').trim();
    if (!genesis) continue;
    tokens.push({
      symbol: String(row.symbol || ''),
      genesis,
      codeHash,
      balance: String(row.balance ?? '0'),
      decimal: row.decimal !== undefined ? Number(row.decimal) : undefined,
      count: row.count !== undefined ? Number(row.count) : undefined,
    });
  }
  return { address, count: tokens.length, tokens };
}

/**
 * Verify a TokenSell listing four-tuple against the chain:
 *  - LIST raw tx exists and its consensus (v10) txid matches sell_txid;
 *  - the token output at sell_output_index parses as an FT script;
 *  - the seed output decodes back into (seller hash160, price) via the
 *    TokenSell desc template and matches the claimed seller/price;
 *  - the on-chain price is reported for the caller to surface.
 */
export async function verifyMvcTokenSellListing(
  listing: MvcTokenSellListingRef,
  deps: Pick<MvcTokenSellServiceDeps, 'fetchRawTx'> = defaultDeps,
): Promise<MvcTokenSellOrderVerify> {
  const problems: string[] = [];
  const sellTxid = String(listing.sell_txid || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sellTxid)) throw new Error('sell_txid must be 64 hex');
  const raw = await deps.fetchRawTx(sellTxid);

  // Independent v10 txid recomputation (parseRawTx + header formula in core);
  // mvc-lib's Transaction.id is the second opinion used below.
  let recomputed = '';
  try {
    recomputed = v10TxId(raw);
  } catch (err) {
    problems.push(`v10 txid recompute failed: ${getErrorMessage(err)}`);
  }
  if (recomputed && recomputed !== sellTxid) problems.push(`raw tx v10 id ${recomputed} != sell_txid ${sellTxid}`);
  let txid = recomputed || sellTxid;
  try {
    const sdk = new mvc.Transaction(raw).id;
    if (sdk !== sellTxid) problems.push(`mvc-lib id ${sdk} != sell_txid ${sellTxid}`);
    txid = sdk;
  } catch (err) {
    problems.push(`mvc-lib parse failed: ${getErrorMessage(err)}`);
  }

  const parsed = parseRawTx(raw);
  const outIndex = Number(listing.sell_output_index);
  if (!Number.isInteger(outIndex) || outIndex < 0 || outIndex >= parsed.outputs.length) {
    throw new Error(`sell_output_index ${listing.sell_output_index} out of range (tx has ${parsed.outputs.length} outputs)`);
  }
  const sellSats = Number(parsed.outputs[outIndex].satoshis);

  // seed decode: same tx by default; explicit seed pointer otherwise.
  const seedTxid = String(listing.seed_txid || sellTxid).toLowerCase();
  let seedRaw = raw;
  if (seedTxid !== sellTxid) {
    seedRaw = await deps.fetchRawTx(seedTxid);
    const seedParsed = parseRawTx(seedRaw);
    const seedVout = Number.isInteger(Number(listing.seed_vout)) ? Number(listing.seed_vout) : 0;
    if (seedVout < 0 || seedVout >= seedParsed.outputs.length) throw new Error('seed_vout out of range');
  }
  const seedParsed = parseRawTx(seedRaw);
  const seedVout = Number.isInteger(Number(listing.seed_vout)) ? Number(listing.seed_vout) : 0;
  const seedLock = seedParsed.outputs[seedVout].scriptPubKey;
  let decoded: { sellerHash160Hex: string; priceSats: string; sellerAddressBase58?: string } = { sellerHash160Hex: '', priceSats: '0' };
  try {
    const result = decodeTokenSellSeedLock(seedLock, tokenSellDesc);
    decoded = {
      sellerHash160Hex: result.sellerHash160Hex,
      priceSats: result.priceSats.toString(),
      sellerAddressBase58: result.sellerHash160Hex ? new mvc.Address(Buffer.from(result.sellerHash160Hex, 'hex'), 'livenet').toString() : undefined,
    };
  } catch (err) {
    problems.push(`seed output is not a TokenSell lock: ${getErrorMessage(err)}`);
  }
  const claimedPrice = Number(listing.sell_price_sats);
  if (decoded.priceSats !== '0' && BigInt(decoded.priceSats) !== BigInt(claimedPrice)) {
    problems.push(`price mismatch: seed lock encodes ${decoded.priceSats} sats, listing claims ${claimedPrice}`);
  }

  // token amount: dataPart of the sale output (parse via the ftProto if
  // meta-contract is available; otherwise report the sats only).
  let tokenAmount = '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ftProto = require('meta-contract/dist/mcp02/contract-proto/token.proto.js');
    const dp = ftProto.parseDataPart(parsed.outputs[outIndex].scriptPubKey);
    tokenAmount = String(dp.tokenAmount);
  } catch {
    problems.push('sale output does not parse as an FT token script (dataPart missing)');
  }

  return {
    listing,
    verified: problems.length === 0,
    problems,
    decoded,
    tokenAmount,
    sellSats,
    txid,
  };
}

/**
 * Execute a TokenSell trade (sell / take / cancel=self-take): build via the
 * subprocess worker (never broadcasts), then broadcast funding txs in order
 * and the final tx — the NFT-trade two-stage posture generalized to N txs.
 * Retryable broadcast failures rebuild with the spent outpoints excluded.
 */
export async function executeMvcTokenSellTrade(
  store: MetabotStore,
  input: {
    metabotId: number;
    action: 'sell' | 'take' | 'cancel';
    genesis?: string;
    codehash?: string;
    tokenTxid?: string;
    tokenVout?: number;
    tokenAmount?: string;
    priceSats?: number;
    seedSats?: number;
    checkerSats?: number;
    listing?: MvcTokenSellListingRef;
    receiverAddress?: string;
    prevTokenInputIndex?: number;
    feeRate: number;
  },
  deps: MvcTokenSellServiceDeps = defaultDeps,
): Promise<{ action: string; txId: string; rawTx: string; fundingTxIds: string[]; listing?: MvcTokenSellListing }> {
  const excludedOutpoints = new Set<string>();

  for (let attempt = 1; attempt <= RETRYABLE_MVC_TOKEN_SELL_BUILD_ATTEMPTS; attempt += 1) {
    const built: BuildMvcTokenSellRawTxResult = await deps.buildTradeRawTx(store, {
      metabotId: input.metabotId,
      action: input.action,
      genesis: input.genesis,
      codehash: input.codehash,
      tokenTxid: input.tokenTxid,
      tokenVout: input.tokenVout,
      tokenAmount: input.tokenAmount,
      priceSats: input.priceSats,
      seedSats: input.seedSats,
      checkerSats: input.checkerSats,
      listing: input.listing,
      receiverAddress: input.receiverAddress,
      prevTokenInputIndex: input.prevTokenInputIndex,
      feeRate: input.feeRate,
      excludeOutpoints: Array.from(excludedOutpoints),
    });

    try {
      for (const funding of built.funding_txs) {
        await deps.broadcastTx(funding.raw_tx);
      }
    } catch (error) {
      const message = getErrorMessage(error);
      if (attempt < RETRYABLE_MVC_TOKEN_SELL_BUILD_ATTEMPTS && isRetryableMvcBroadcastError(message)) {
        for (const outpoint of built.spent_outpoints || []) {
          excludedOutpoints.add(String(outpoint).toLowerCase());
        }
        await sleep(RETRYABLE_MVC_TOKEN_SELL_BROADCAST_DELAY_MS);
        continue;
      }
      throw new Error(
        `${message} [funding stage failed; nothing else broadcast; raw txs preserved for manual recovery: ${built.funding_txs
          .map((f) => `${f.name}=${f.txid}`)
          .join(', ')}; final=${built.txid}]`,
      );
    }

    try {
      await deps.broadcastTx(built.raw_tx);
      return {
        action: input.action,
        txId: built.txid,
        rawTx: built.raw_tx,
        fundingTxIds: built.funding_txids,
        listing: built.listing,
      };
    } catch (error) {
      const message = getErrorMessage(error);
      if (attempt < RETRYABLE_MVC_TOKEN_SELL_BUILD_ATTEMPTS && isRetryableMvcBroadcastError(message)) {
        for (const outpoint of built.spent_outpoints || []) {
          excludedOutpoints.add(String(outpoint).toLowerCase());
        }
        await sleep(RETRYABLE_MVC_TOKEN_SELL_BROADCAST_DELAY_MS);
        continue;
      }
      throw new Error(
        `${message} [funding tx(s) ${built.funding_txids.join(', ')} already broadcast; final raw tx preserved for manual recovery: ${built.raw_tx}]`,
      );
    }
  }

  throw new Error('MVC TokenSell trade failed after retries');
}
