/**
 * Local RPC Gateway Route Handlers for FT Broker Commerce Loop (`Contract C4.1`).
 *
 * Pure, dependency-injected handlers mounted on `metaidRpcServer.ts` (`127.0.0.1`):
 * - `POST /api/idbots/commerce/ft-mandate-confirm`
 * - `POST /api/idbots/wallet/mvc/ft-split`
 * - `POST /api/idbots/wallet/mvc/token-sell/verify`
 * - `POST /api/idbots/wallet/mvc/token-sell/list`
 * - `POST /api/idbots/wallet/mvc/token-sell/buy`
 * - `POST /api/idbots/wallet/mvc/token-sell/cancel`
 * - `POST /api/idbots/commerce/ft-escrow/buy`
 * - `GET  /api/idbots/commerce/ft-escrow/orders/:orderId`
 * - `POST /api/idbots/commerce/ft-watch/register`
 * - `POST /api/idbots/commerce/ft-watch/list`
 */

import crypto from 'crypto';
import type { SqliteDatabase as Database } from '../sqliteTypes';
import type { MetabotStore } from '../metabotStore';
import {
  FtMandateError,
  defaultFtMandateGate,
  normalizeFtAssetKey,
  type FtMandateAction,
  type FtMandateDraft,
  type FtMandateGate,
  type FtMandateRail,
} from './ftMandateGateService';
import {
  MeFtEscrowApiError,
  createFtEscrowOrder,
  getFtEscrowOrder,
  resolveMetabotFtEscrowSigner,
  type FtEscrowSigner,
  type CreateFtEscrowOrderParams,
  type MeFtEscrowOrder,
} from './meFtEscrowService';
import {
  type FtActiveOrderRecord,
  type FtSellPinPayloadV1,
  getFtBatchOrderProgress,
  listFtActiveOrders,
  markFtOrdersCanceledByOutpoint,
  registerFtActiveOrder,
  updateFtOrderStatus,
  validateFtSellPinPayload,
} from './ftOrderStore';
import {
  executeMvcTokenSellTrade,
  verifyMvcTokenSellListing,
  type MvcTokenSellOrderVerify,
} from './mvcTokenSellService';
import {
  buildMvcFtTransferRawTx,
  type MvcTokenSellListing,
  type MvcTokenSellListingRef,
} from './walletRawTxService';

type BuildMvcFtSplitRawTxResult = Awaited<ReturnType<typeof buildMvcFtTransferRawTx>>;
import { broadcastMvcFtTransferBundle, recordMvcFtBundleSpendSession } from './mvcFtService';
import { resolveBroadcastTxResult } from '../libs/mvcSpend';
import { getRate as getGlobalFeeRate } from './feeRateStore';
import { createPin, type MetaidDataPayload } from './metaidCore';
import { formatGoodsTradeWireMessage } from './goodsTradeWireProtocol';
import { listMvcFtIssuances } from './mvcFtIssueService';

function resolveChainGenesisFromIssuances(
  db: Database,
  metabotId: number,
  codehash: string,
  genesis: string,
): string {
  const clean = genesis.trim().toLowerCase();
  if (clean.length === 40) return clean;
  if (clean.length === 64 || clean.length === 72) {
    try {
      const issued = listMvcFtIssuances(db, { metabotId, limit: 100 });
      const hit = issued.find(
        (r) =>
          r.codehash.toLowerCase() === codehash.toLowerCase() &&
          (r.genesisTxId.toLowerCase() === clean ||
            r.sensibleId.toLowerCase() === clean ||
            r.sensibleId.toLowerCase().startsWith(clean)),
      );
      if (hit?.genesis) return hit.genesis.toLowerCase();
    } catch {
      // Fall back to caller genesis if issuance table lookup fails
    }
  }
  return clean;
}

export const FT_MANDATE_CONFIRM_PATH = '/api/idbots/commerce/ft-mandate-confirm';
export const FT_MVC_SPLIT_PATH = '/api/idbots/wallet/mvc/ft-split';
export const FT_MVC_TOKEN_SELL_VERIFY_PATH = '/api/idbots/wallet/mvc/token-sell/verify';
export const FT_MVC_TOKEN_SELL_LIST_PATH = '/api/idbots/wallet/mvc/token-sell/list';
export const FT_MVC_TOKEN_SELL_BUY_PATH = '/api/idbots/wallet/mvc/token-sell/buy';
export const FT_MVC_TOKEN_SELL_CANCEL_PATH = '/api/idbots/wallet/mvc/token-sell/cancel';
export const FT_ESCROW_BUY_PATH = '/api/idbots/commerce/ft-escrow/buy';
export const FT_ESCROW_ORDER_PREFIX = '/api/idbots/commerce/ft-escrow/orders/';
export const FT_WATCH_REGISTER_PATH = '/api/idbots/commerce/ft-watch/register';
export const FT_WATCH_LIST_PATH = '/api/idbots/commerce/ft-watch/list';

const METALET_HOST = 'https://www.metalet.space';

export interface GatewayRouteResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface FtCommerceGatewayDeps {
  getDb: () => Database;
  saveDb?: () => void;
  getMetabotStore: () => MetabotStore;
  mandateGate?: FtMandateGate;
  resolveMvcFeeRate?: () => number;
  buildFtSplitRawTx?: (
    store: MetabotStore,
    params: {
      metabotId: number;
      token: { codeHash: string; genesisHash: string };
      toAddress: string;
      amount: string;
      feeRate: number;
      excludeOutpoints?: string[];
    },
  ) => Promise<BuildMvcFtSplitRawTxResult>;
  broadcastMvcRawTx?: (rawTx: string) => Promise<string>;
  verifyTokenSellListing?: (listing: MvcTokenSellListingRef) => Promise<MvcTokenSellOrderVerify>;
  executeTokenSellTrade?: typeof executeMvcTokenSellTrade;
  resolveEscrowSigner?: (store: MetabotStore, metabotId: number) => FtEscrowSigner;
  createEscrowOrder?: (
    signer: FtEscrowSigner,
    params: CreateFtEscrowOrderParams,
  ) => Promise<MeFtEscrowOrder>;
  getEscrowOrder?: (signer: FtEscrowSigner, orderId: string) => Promise<MeFtEscrowOrder>;
  createChainPin?: (
    metabotId: number,
    payload: MetaidDataPayload,
    feeRate?: number,
  ) => Promise<{ txids: string[]; pinId: string }>;
  sendEncryptedPrivateMessage?: (
    fromMetabotId: number,
    toGlobalMetaId: string,
    plaintext: string,
  ) => Promise<{ pinId?: string } | void>;
}

function defaultBroadcastMvcRawTx(rawTx: string): Promise<string> {
  return fetch(`${METALET_HOST}/wallet-api/v3/tx/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chain: 'mvc', net: 'livenet', rawTx }),
  })
    .then((res) => res.json() as Promise<{ code?: number; message?: string; data?: string }>)
    .then((json) => resolveBroadcastTxResult(rawTx, json));
}

function parseJsonBody(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawBody || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseListingJsonInput(value: unknown): MvcTokenSellListingRef {
  if (typeof value === 'string' && value.trim()) {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('tokenSellJson must decode to a JSON object');
    }
    return parsed as MvcTokenSellListingRef;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as MvcTokenSellListingRef;
  }
  throw new Error('tokenSellJson (or listing object) is required');
}

function parseOutpoint(outpoint: unknown): { txid: string; vout: number } | null {
  const raw = String(outpoint ?? '').trim();
  if (!raw) return null;
  const match = /^([0-9a-fA-F]{64}):(\d+)$/.exec(raw);
  if (!match) {
    throw new Error(`Invalid utxoOutpoint '${raw}' (expected <64-hex-txid>:<vout>)`);
  }
  return { txid: match[1].toLowerCase(), vout: Number(match[2]) };
}

function formatAtomicDisplay(amountBase: string, decimals: number): string {
  const clean = BigInt(amountBase);
  const dec = Math.max(0, Math.trunc(decimals));
  if (dec === 0) return clean.toString();
  const base = 10n ** BigInt(dec);
  const whole = clean / base;
  const frac = (clean % base).toString().padStart(dec, '0').replace(/0+$/, '');
  return frac ? `${whole.toString()}.${frac}` : whole.toString();
}

function formatErrorResponse(err: unknown): GatewayRouteResponse {
  if (err instanceof FtMandateError) {
    return {
      status: 403,
      body: {
        success: false,
        errorCode: err.code,
        error: err.message,
      },
    };
  }
  if (err instanceof MeFtEscrowApiError) {
    const status = err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 502;
    return {
      status,
      body: {
        success: false,
        ...(err.errorCode ? { errorCode: err.errorCode } : {}),
        error: err.message,
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  const isClientErr =
    /required|invalid|must be|mismatch|UTXO_RAIL_CONFLICT|SELF_TRADE|out of range|not found/i.test(
      message,
    );
  return {
    status: isClientErr ? 400 : 500,
    body: {
      success: false,
      error: message,
    },
  };
}

export async function handleFtMandateConfirmRoute(
  deps: FtCommerceGatewayDeps,
  rawBody: string,
): Promise<GatewayRouteResponse> {
  const body = parseJsonBody(rawBody);
  if (!body) {
    return { status: 400, body: { success: false, error: 'Invalid JSON object body' } };
  }
  const gate = deps.mandateGate ?? defaultFtMandateGate;
  try {
    const draft: Partial<FtMandateDraft> = {
      metabotId: Number(body.metabotId ?? body.metabot_id),
      action: String(body.action ?? '') as FtMandateAction,
      assetKey: String(body.assetKey ?? body.asset_key ?? ''),
      symbol: String(body.symbol ?? 'TOKEN'),
      ...(body.decimals !== undefined ? { decimals: Number(body.decimals) } : {}),
      rail: String(body.rail ?? '') as FtMandateRail,
      totalTokenDisplay: String(body.totalTokenDisplay ?? body.total_token_display ?? ''),
      lotCount: Number(body.lotCount ?? body.lot_count ?? 1),
      maxSpendDisplay: String(body.maxSpendDisplay ?? body.max_spend_display ?? ''),
      maxSpendAmount: String(body.maxSpendAmount ?? body.max_spend_amount ?? '0'),
      estimatedGasDisplay: String(body.estimatedGasDisplay ?? body.estimated_gas_display ?? '-'),
      caVerified: Boolean(body.caVerified ?? body.ca_verified),
      ...(typeof (body.sessionId ?? body.session_id) === 'string'
        ? { sessionId: String(body.sessionId ?? body.session_id) }
        : {}),
    };
    const result = await gate.requestMandate(draft);
    return {
      status: 200,
      body: {
        success: true,
        confirmed: result.confirmed,
        ...(result.mandateToken ? { mandateToken: result.mandateToken } : {}),
        ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      },
    };
  } catch (err) {
    return formatErrorResponse(err);
  }
}

export async function handleMvcFtSplitRoute(
  deps: FtCommerceGatewayDeps,
  rawBody: string,
): Promise<GatewayRouteResponse> {
  const body = parseJsonBody(rawBody);
  if (!body) {
    return { status: 400, body: { success: false, error: 'Invalid JSON object body' } };
  }
  const gate = deps.mandateGate ?? defaultFtMandateGate;
  try {
    const metabotId = Number(body.metabotId ?? body.metabot_id);
    const mandateToken = String(body.mandateToken ?? body.mandate_token ?? '').trim();
    const codehash = String(body.codehash ?? body.codeHash ?? '').trim().toLowerCase();
    const genesis = String(body.genesis ?? '').trim().toLowerCase();
    if (!codehash || !genesis) {
      return { status: 400, body: { success: false, error: 'codehash and genesis are required' } };
    }
    const assetKey = normalizeFtAssetKey(`mvc-ft:${codehash}:${genesis}`);
    const lotAmountsRaw = body.lotAmountsBase ?? body.lot_amounts_base;
    if (!Array.isArray(lotAmountsRaw) || lotAmountsRaw.length === 0) {
      return {
        status: 400,
        body: { success: false, error: 'lotAmountsBase must be a non-empty array of integer strings' },
      };
    }
    const lotAmountsBase = lotAmountsRaw.map((item, idx) => {
      const text = String(item ?? '').trim();
      if (!/^[1-9]\d*$/.test(text)) {
        throw new Error(`lotAmountsBase[${idx}] must be a positive integer string`);
      }
      return text;
    });

    const mandate = gate.verifyMandate({
      mandateToken,
      metabotId,
      action: 'list-lots',
      assetKey,
    });
    if (lotAmountsBase.length > mandate.maxLots) {
      throw new FtMandateError(
        'MANDATE_LOT_LIMIT_EXCEEDED',
        `Requested ${lotAmountsBase.length} split lots, but mandate only allows ${mandate.maxLots}`,
      );
    }

    const store = deps.getMetabotStore();
    const bot = store.getMetabotById(metabotId);
    if (!bot?.mvc_address) {
      return { status: 400, body: { success: false, error: `MetaBot ${metabotId} MVC address not found` } };
    }

    const feeRate = Number(body.feeRate ?? body.fee_rate) > 0
      ? Number(body.feeRate ?? body.fee_rate)
      : (deps.resolveMvcFeeRate?.() ?? getGlobalFeeRate('mvc'));
    const buildFn = deps.buildFtSplitRawTx ?? buildMvcFtTransferRawTx;
    const broadcastFn = deps.broadcastMvcRawTx ?? defaultBroadcastMvcRawTx;

    const txids: string[] = [];
    const lotOutpoints: Array<{ outpoint: string; amountBase: string }> = [];
    const protectedLotOutpoints: string[] = [];

    const chainGenesis = resolveChainGenesisFromIssuances(deps.getDb(), metabotId, codehash, genesis);

    for (const amountBase of lotAmountsBase) {
      const built = await buildFn(store, {
        metabotId,
        token: { codeHash: codehash, genesisHash: chainGenesis },
        toAddress: bot.mvc_address,
        amount: amountBase,
        feeRate,
        excludeOutpoints: protectedLotOutpoints.length > 0 ? [...protectedLotOutpoints] : undefined,
      });
      const broadcasted = await broadcastMvcFtTransferBundle(
        {
          amountCheckRawTx: built.amount_check_raw_tx,
          rawTx: built.raw_tx,
        },
        broadcastFn,
      );
      recordMvcFtBundleSpendSession({
        metabotId,
        walletAddress: bot.mvc_address,
        amountCheckRawTx: built.amount_check_raw_tx,
        rawTx: built.raw_tx,
        txId: broadcasted.txId,
      });
      const outpoint = `${broadcasted.txId.toLowerCase()}:${built.output_index}`;
      txids.push(broadcasted.txId);
      lotOutpoints.push({ outpoint, amountBase });
      // Protect newly split exact-lot UTXOs so subsequent splits only consume FT change!
      protectedLotOutpoints.push(outpoint);
    }

    return {
      status: 200,
      body: {
        success: true,
        txids,
        lotOutpoints,
      },
    };
  } catch (err) {
    return formatErrorResponse(err);
  }
}

export async function handleMvcTokenSellVerifyRoute(
  deps: FtCommerceGatewayDeps,
  rawBody: string,
): Promise<GatewayRouteResponse> {
  const body = parseJsonBody(rawBody);
  if (!body) {
    return { status: 400, body: { success: false, error: 'Invalid JSON object body' } };
  }
  try {
    const listingRef = parseListingJsonInput(
      body.tokenSellJson ?? body.token_sell_json ?? body.listing,
    );
    const verifyFn = deps.verifyTokenSellListing ?? verifyMvcTokenSellListing;
    const report = await verifyFn(listingRef);
    const problems = [...report.problems];

    const expectedPrice = body.expectedPriceSats ?? body.expected_price_sats;
    if (expectedPrice !== undefined && expectedPrice !== null) {
      if (BigInt(report.decoded.priceSats) !== BigInt(String(expectedPrice))) {
        problems.push(
          `expectedPriceSats ${String(expectedPrice)} != on-chain ${report.decoded.priceSats}`,
        );
      }
    }
    const expectedSeller = String(
      body.expectedSellerAddress ?? body.expected_seller_address ?? '',
    ).trim();
    if (expectedSeller && report.decoded.sellerAddressBase58 && report.decoded.sellerAddressBase58 !== expectedSeller) {
      problems.push(
        `expectedSellerAddress ${expectedSeller} != on-chain ${report.decoded.sellerAddressBase58}`,
      );
    }
    const expectedMinAmountBase = String(
      body.expectedMinAmountBase ?? body.expected_min_amount_base ?? '',
    ).trim();
    if (expectedMinAmountBase && report.tokenAmount) {
      if (BigInt(report.tokenAmount) < BigInt(expectedMinAmountBase)) {
        problems.push(
          `on-chain tokenAmount ${report.tokenAmount} < expectedMinAmountBase ${expectedMinAmountBase}`,
        );
      }
    }

    const verified = report.verified && problems.length === 0;
    return {
      status: 200,
      body: {
        success: true,
        verified,
        problems,
        decoded: report.decoded,
        tokenAmount: report.tokenAmount,
        sellSats: report.sellSats,
        txid: report.txid,
        listing: report.listing,
      },
    };
  } catch (err) {
    return formatErrorResponse(err);
  }
}

export async function handleMvcTokenSellListRoute(
  deps: FtCommerceGatewayDeps,
  rawBody: string,
): Promise<GatewayRouteResponse> {
  const body = parseJsonBody(rawBody);
  if (!body) {
    return { status: 400, body: { success: false, error: 'Invalid JSON object body' } };
  }
  const gate = deps.mandateGate ?? defaultFtMandateGate;
  try {
    const metabotId = Number(body.metabotId ?? body.metabot_id);
    const mandateToken = String(body.mandateToken ?? body.mandate_token ?? '').trim();
    const codehash = String(body.codehash ?? body.codeHash ?? '').trim().toLowerCase();
    const genesis = String(body.genesis ?? '').trim().toLowerCase();
    const symbol = String(body.symbol ?? 'TOKEN').trim();
    const decimals = Number(body.decimals ?? 0) || 0;
    const amountBase = String(body.amountBase ?? body.amount_base ?? body.tokenAmount ?? '').trim();
    const priceSats = Number(body.priceSats ?? body.price_sats);
    if (!codehash || !genesis) {
      return { status: 400, body: { success: false, error: 'codehash and genesis are required' } };
    }
    if (!/^[1-9]\d*$/.test(amountBase)) {
      return { status: 400, body: { success: false, error: 'amountBase must be a positive integer string' } };
    }
    if (!Number.isInteger(priceSats) || priceSats <= 0) {
      return { status: 400, body: { success: false, error: 'priceSats must be a positive integer' } };
    }

    const assetKey = normalizeFtAssetKey(`mvc-ft:${codehash}:${genesis}`);
    const outpointParsed = parseOutpoint(body.utxoOutpoint ?? body.utxo_outpoint);

    gate.consumeMandate({
      mandateToken,
      metabotId,
      action: 'list-lots',
      assetKey,
      rail: 'mvc-tokensell',
      spendAmount: 0n,
      lots: 1,
    });

    const store = deps.getMetabotStore();
    const bot = store.getMetabotById(metabotId);
    if (!bot) {
      gate.rollbackMandate(mandateToken, 0n, 1);
      return { status: 404, body: { success: false, error: `MetaBot ${metabotId} not found` } };
    }
    const feeRate = Number(body.feeRate ?? body.fee_rate) > 0
      ? Number(body.feeRate ?? body.fee_rate)
      : (deps.resolveMvcFeeRate?.() ?? getGlobalFeeRate('mvc'));

    const execTrade = deps.executeTokenSellTrade ?? executeMvcTokenSellTrade;
    let tradeResult: {
      action: string;
      txId: string;
      rawTx: string;
      fundingTxIds: string[];
      listing?: MvcTokenSellListing;
    };
    const chainGenesis = resolveChainGenesisFromIssuances(deps.getDb(), metabotId, codehash, genesis);
    try {
      tradeResult = await execTrade(store, {
        metabotId,
        action: 'sell',
        codehash,
        genesis: chainGenesis,
        tokenTxid: outpointParsed?.txid,
        tokenVout: outpointParsed?.vout,
        tokenAmount: amountBase,
        priceSats,
        feeRate,
      });
    } catch (tradeErr) {
      gate.rollbackMandate(mandateToken, 0n, 1);
      throw tradeErr;
    }

    const listingObj = tradeResult.listing ?? {
      sell_txid: tradeResult.txId,
      sell_output_index: 0,
      sell_price_sats: priceSats,
      seed_txid: tradeResult.txId,
      seed_vout: 1,
    };
    const tokenSellJson = JSON.stringify(listingObj);
    const lockedOutpoint = `${String(listingObj.sell_txid || tradeResult.txId).toLowerCase()}:${Number(listingObj.sell_output_index ?? 0)}`;
    const listingKey =
      String(body.listingKey ?? body.listing_key ?? '').trim() ||
      `mvc-tsell-${tradeResult.txId.slice(0, 16)}-${Number(listingObj.sell_output_index ?? 0)}`;
    const batchGroupId = String(body.batchGroupId ?? body.batch_group_id ?? '').trim() || listingKey;
    const amountDisplay =
      String(body.amountDisplay ?? body.amount_display ?? '').trim() ||
      formatAtomicDisplay(amountBase, decimals);

    let sellPinId: string | undefined;
    if (body.broadcastFtSellPin !== false && body.broadcast_ft_sell_pin !== false) {
      const pinPayload: FtSellPinPayloadV1 = {
        version: '1.0',
        active: true,
        listingKey,
        batchGroupId,
        asset: {
          chain: 'mvc',
          standard: 'mvc-ft',
          assetKey,
          symbol,
          decimals,
          codehash,
          genesis,
          ...(typeof body.caPinId === 'string' && body.caPinId.trim()
            ? { caPinId: body.caPinId.trim() }
            : {}),
        },
        lot: {
          amountBase,
          amountDisplay,
          utxoOutpoint: lockedOutpoint,
          ...(body.lotIndex !== undefined ? { lotIndex: Number(body.lotIndex) } : {}),
          ...(body.lotTotal !== undefined ? { lotTotal: Number(body.lotTotal) } : {}),
        },
        seller: {
          globalMetaId: bot.globalmetaid || '',
          botMvcAddress: bot.mvc_address,
          ...(bot.btc_address ? { botBtcAddress: bot.btc_address } : {}),
        },
        rails: {
          mvcTokenSell: {
            priceSats,
            contractAddress: String((listingObj as Record<string, unknown>).contract_address ?? ''),
            txid: tradeResult.txId,
            tokenSellJson,
          },
        },
      };
      validateFtSellPinPayload(pinPayload);
      const pinWriter =
        deps.createChainPin ??
        ((id, payload, fr) => createPin(store, id, payload, { network: 'mvc', feeRate: fr }));
      try {
        const pinRes = await pinWriter(
          metabotId,
          {
            operation: 'create',
            path: '/protocols/ft-sell',
            encryption: '0',
            version: '1.0',
            contentType: 'application/json',
            payload: JSON.stringify(pinPayload),
          },
          feeRate,
        );
        sellPinId = pinRes.pinId;
      } catch {
        // Non-fatal if /protocols/ft-sell pin broadcast fails after TokenSell UTXO lock succeeded
      }
    }

    const activeOrder = registerFtActiveOrder(
      deps.getDb(),
      {
        listingKey,
        batchGroupId,
        metabotId,
        assetKey,
        chain: 'mvc',
        symbol,
        decimals,
        codehash,
        genesis,
        rail: 'mvc-tokensell',
        amountBase,
        amountDisplay,
        utxoOutpoint: lockedOutpoint,
        priceSats,
        autoFulfillMe: false,
        sellPinId,
        tokenSellJson,
        sellerAddress: bot.mvc_address,
        ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      },
      deps.saveDb,
    );

    return {
      status: 200,
      body: {
        success: true,
        txid: tradeResult.txId,
        fundingTxIds: tradeResult.fundingTxIds,
        listingKey: activeOrder.listingKey,
        batchGroupId: activeOrder.batchGroupId,
        utxoOutpoint: activeOrder.utxoOutpoint,
        contractAddress: String((listingObj as Record<string, unknown>).contract_address ?? ''),
        tokenSellJson,
        ...(sellPinId ? { sellPinId } : {}),
      },
    };
  } catch (err) {
    return formatErrorResponse(err);
  }
}

export async function handleMvcTokenSellBuyRoute(
  deps: FtCommerceGatewayDeps,
  rawBody: string,
): Promise<GatewayRouteResponse> {
  const body = parseJsonBody(rawBody);
  if (!body) {
    return { status: 400, body: { success: false, error: 'Invalid JSON object body' } };
  }
  const gate = deps.mandateGate ?? defaultFtMandateGate;
  try {
    const metabotId = Number(body.metabotId ?? body.metabot_id);
    const mandateToken = String(body.mandateToken ?? body.mandate_token ?? '').trim();
    const assetKey = normalizeFtAssetKey(body.assetKey ?? body.asset_key);
    const listingRef = parseListingJsonInput(
      body.tokenSellJson ?? body.token_sell_json ?? body.listing,
    );

    // Mandatory pre-sign byte-level contract verification (Contract C4.1 / WS-1 anti-fraud redline)
    const verifyFn = deps.verifyTokenSellListing ?? verifyMvcTokenSellListing;
    const verification = await verifyFn(listingRef);
    if (!verification.verified) {
      return {
        status: 400,
        body: {
          success: false,
          errorCode: 'TOKEN_SELL_VERIFY_FAILED',
          error: `TokenSell contract verification failed: ${verification.problems.join('; ')}`,
          problems: verification.problems,
        },
      };
    }

    const onChainPriceSats = BigInt(verification.decoded.priceSats);
    if (onChainPriceSats <= 0n) {
      return {
        status: 400,
        body: {
          success: false,
          errorCode: 'TOKEN_SELL_VERIFY_FAILED',
          error: 'Decoded on-chain TokenSell priceSats is zero',
        },
      };
    }

    const expectedSeller = String(
      body.expectedSellerAddress ?? body.expected_seller_address ?? '',
    ).trim();
    if (
      expectedSeller &&
      verification.decoded.sellerAddressBase58 &&
      verification.decoded.sellerAddressBase58 !== expectedSeller
    ) {
      return {
        status: 400,
        body: {
          success: false,
          errorCode: 'TOKEN_SELL_SELLER_MISMATCH',
          error: `On-chain seller ${verification.decoded.sellerAddressBase58} != expected ${expectedSeller}`,
        },
      };
    }

    const expectedMinAmountBase = String(
      body.expectedMinAmountBase ?? body.expected_min_amount_base ?? '',
    ).trim();
    if (expectedMinAmountBase && verification.tokenAmount) {
      if (BigInt(verification.tokenAmount) < BigInt(expectedMinAmountBase)) {
        return {
          status: 400,
          body: {
            success: false,
            errorCode: 'TOKEN_SELL_AMOUNT_MISMATCH',
            error: `On-chain tokenAmount ${verification.tokenAmount} < expected ${expectedMinAmountBase}`,
          },
        };
      }
    }

    const consumed = gate.consumeMandate({
      mandateToken,
      metabotId,
      action: 'buy-sweep',
      assetKey,
      rail: 'mvc-tokensell',
      spendAmount: onChainPriceSats,
      lots: 1,
    });

    const feeRate = Number(body.feeRate ?? body.fee_rate) > 0
      ? Number(body.feeRate ?? body.fee_rate)
      : (deps.resolveMvcFeeRate?.() ?? getGlobalFeeRate('mvc'));
    const execTrade = deps.executeTokenSellTrade ?? executeMvcTokenSellTrade;

    let tradeRes: {
      action: string;
      txId: string;
      rawTx: string;
      fundingTxIds: string[];
    };
    try {
      tradeRes = await execTrade(deps.getMetabotStore(), {
        metabotId,
        action: 'take',
        listing: listingRef,
        feeRate,
      });
    } catch (tradeErr) {
      gate.rollbackMandate(mandateToken, onChainPriceSats, 1);
      throw tradeErr;
    }

    return {
      status: 200,
      body: {
        success: true,
        txid: tradeRes.txId,
        fundingTxIds: tradeRes.fundingTxIds,
        paidSats: onChainPriceSats.toString(),
        receivedTokenAmountBase: verification.tokenAmount,
        remainingSpendAmount: consumed.remainingSpendAmount,
        remainingLots: consumed.remainingLots,
      },
    };
  } catch (err) {
    return formatErrorResponse(err);
  }
}

export async function handleMvcTokenSellCancelRoute(
  deps: FtCommerceGatewayDeps,
  rawBody: string,
): Promise<GatewayRouteResponse> {
  const body = parseJsonBody(rawBody);
  if (!body) {
    return { status: 400, body: { success: false, error: 'Invalid JSON object body' } };
  }
  const gate = deps.mandateGate ?? defaultFtMandateGate;
  try {
    const metabotId = Number(body.metabotId ?? body.metabot_id);
    const mandateToken = String(body.mandateToken ?? body.mandate_token ?? '').trim();
    const assetKey = normalizeFtAssetKey(body.assetKey ?? body.asset_key);
    const listingRef = parseListingJsonInput(
      body.tokenSellJson ?? body.token_sell_json ?? body.listing,
    );

    if (mandateToken) {
      gate.consumeMandate({
        mandateToken,
        metabotId,
        action: 'cancel',
        assetKey,
        rail: 'mvc-tokensell',
        spendAmount: 0n,
        lots: 1,
      });
    }

    const outpoint = `${String(listingRef.sell_txid || '').toLowerCase()}:${Number(listingRef.sell_output_index ?? 0)}`;
    const feeRate = Number(body.feeRate ?? body.fee_rate) > 0
      ? Number(body.feeRate ?? body.fee_rate)
      : (deps.resolveMvcFeeRate?.() ?? getGlobalFeeRate('mvc'));
    const execTrade = deps.executeTokenSellTrade ?? executeMvcTokenSellTrade;

    let tradeRes: { txId: string; fundingTxIds: string[] };
    try {
      tradeRes = await execTrade(deps.getMetabotStore(), {
        metabotId,
        action: 'cancel',
        listing: listingRef,
        feeRate,
      });
    } catch (cancelErr) {
      if (mandateToken) gate.rollbackMandate(mandateToken, 0n, 1);
      throw cancelErr;
    }

    // Immediately mark canceled in SQLite so TokenOrderWatcher does not classify self-cancel as an external fill!
    const listingKey = String(body.listingKey ?? body.listing_key ?? '').trim();
    if (listingKey) {
      updateFtOrderStatus(deps.getDb(), listingKey, 'canceled', { filledTxId: tradeRes.txId }, deps.saveDb);
    }
    markFtOrdersCanceledByOutpoint(deps.getDb(), metabotId, outpoint, Date.now(), deps.saveDb);

    let cancelPinId: string | undefined;
    if (listingKey && body.broadcastCancelPin !== false && body.broadcast_cancel_pin !== false) {
      const store = deps.getMetabotStore();
      const bot = store.getMetabotById(metabotId);
      if (bot) {
        const pinWriter =
          deps.createChainPin ??
          ((id, payload, fr) => createPin(store, id, payload, { network: 'mvc', feeRate: fr }));
        try {
          const pinRes = await pinWriter(
            metabotId,
            {
              operation: 'create',
              path: '/protocols/ft-sell',
              encryption: '0',
              version: '1.0',
              contentType: 'application/json',
              payload: JSON.stringify({
                version: '1.0',
                active: false,
                listingKey,
                batchGroupId: String(body.batchGroupId ?? body.batch_group_id ?? listingKey),
                asset: { assetKey },
                lot: { utxoOutpoint: outpoint },
                seller: { globalMetaId: bot.globalmetaid || '', botMvcAddress: bot.mvc_address },
                rails: {},
              }),
            },
            feeRate,
          );
          cancelPinId = pinRes.pinId;
        } catch {
          // Non-fatal
        }
      }
    }

    return {
      status: 200,
      body: {
        success: true,
        txid: tradeRes.txId,
        fundingTxIds: tradeRes.fundingTxIds,
        canceledOutpoint: outpoint,
        ...(cancelPinId ? { cancelPinId } : {}),
      },
    };
  } catch (err) {
    return formatErrorResponse(err);
  }
}

export async function handleFtEscrowBuyRoute(
  deps: FtCommerceGatewayDeps,
  rawBody: string,
): Promise<GatewayRouteResponse> {
  const body = parseJsonBody(rawBody);
  if (!body) {
    return { status: 400, body: { success: false, error: 'Invalid JSON object body' } };
  }
  const gate = deps.mandateGate ?? defaultFtMandateGate;
  try {
    const metabotId = Number(body.metabotId ?? body.metabot_id);
    const mandateToken = String(body.mandateToken ?? body.mandate_token ?? '').trim();
    const chain: 'mvc' | 'btc' = String(body.chain ?? 'mvc').toLowerCase() === 'btc' ? 'btc' : 'mvc';
    const assetKey = normalizeFtAssetKey(body.assetKey ?? body.asset_key);
    const tokenSymbol = String(body.tokenSymbol ?? body.token_symbol ?? body.symbol ?? 'TOKEN').trim();
    const tokenDecimals = Number(body.tokenDecimals ?? body.token_decimals ?? body.decimals ?? 0) || 0;
    const tokenAmountBase = String(body.tokenAmountBase ?? body.token_amount_base ?? '').trim();
    const amountMilli = Number(body.amountMilli ?? body.amount_milli);
    const sellerBotAddress = String(body.sellerBotAddress ?? body.seller_bot_address ?? '').trim();
    const sellerPayeeAddress = String(
      body.sellerPayeeAddress ?? body.seller_payee_address ?? sellerBotAddress,
    ).trim();
    const sellerGlobalMetaId = String(
      body.sellerGlobalMetaId ?? body.seller_global_metaid ?? '',
    ).trim();

    if (!Number.isInteger(amountMilli) || amountMilli <= 0) {
      return { status: 400, body: { success: false, error: 'amountMilli must be a positive integer' } };
    }

    const store = deps.getMetabotStore();
    const buyerBot = store.getMetabotById(metabotId);
    if (!buyerBot) {
      return { status: 404, body: { success: false, error: `MetaBot ${metabotId} not found` } };
    }

    const defaultReceiveAddr = chain === 'btc' ? buyerBot.btc_address : buyerBot.mvc_address;
    const buyerReceiveAddress = String(
      body.buyerReceiveAddress ?? body.buyer_receive_address ?? defaultReceiveAddr ?? '',
    ).trim();

    const consumed = gate.consumeMandate({
      mandateToken,
      metabotId,
      action: 'buy-sweep',
      assetKey,
      rail: 'me-escrow',
      spendAmount: BigInt(amountMilli),
      lots: 1,
    });

    const resolveSigner = deps.resolveEscrowSigner ?? resolveMetabotFtEscrowSigner;
    const signer = resolveSigner(store, metabotId);
    const createOrderFn = deps.createEscrowOrder ?? createFtEscrowOrder;
    const idempotencyKey =
      String(body.idempotencyKey ?? body.idempotency_key ?? '').trim() ||
      `ftesc_${metabotId}_${crypto.randomBytes(10).toString('hex')}`;

    let escrowOrder: MeFtEscrowOrder;
    try {
      escrowOrder = await createOrderFn(signer, {
        sellerBotAddress,
        sellerPayeeAddress,
        chain,
        assetKey,
        tokenSymbol,
        tokenDecimals,
        tokenAmountBase,
        amountMilli,
        buyerReceiveAddress,
        ...(body.listingKey || body.listing_key
          ? { listingKey: String(body.listingKey ?? body.listing_key) }
          : {}),
        ...(body.lockedUtxoOutpoint || body.locked_utxo_outpoint
          ? { lockedUtxoOutpoint: String(body.lockedUtxoOutpoint ?? body.locked_utxo_outpoint) }
          : {}),
        idempotencyKey,
        ttlSeconds: Number(body.ttlSeconds ?? body.ttl_seconds) > 0
          ? Number(body.ttlSeconds ?? body.ttl_seconds)
          : 1800,
      });
    } catch (escrowErr) {
      gate.rollbackMandate(mandateToken, BigInt(amountMilli), 1);
      throw escrowErr;
    }

    let dmSent = false;
    if (sellerGlobalMetaId && deps.sendEncryptedPrivateMessage) {
      try {
        const wireMsg = formatGoodsTradeWireMessage({
          type: 'ME_FT_ESCROW_LOCKED_V1',
          orderId: escrowOrder.orderId,
          assetKey: escrowOrder.assetKey,
          chain: escrowOrder.chain,
          tokenSymbol: escrowOrder.tokenSymbol,
          tokenDecimals: escrowOrder.tokenDecimals,
          tokenAmountBase: escrowOrder.tokenAmountBase,
          amountMilli: escrowOrder.amountMilli,
          buyerReceiveAddress: escrowOrder.buyerReceiveAddress,
          sellerBotAddress: escrowOrder.sellerBotAddress,
          ...(escrowOrder.listingKey ? { listingKey: escrowOrder.listingKey } : {}),
          ...(escrowOrder.lockedUtxoOutpoint
            ? { lockedUtxoOutpoint: escrowOrder.lockedUtxoOutpoint }
            : {}),
          ...(buyerBot.globalmetaid ? { buyerGlobalMetaId: buyerBot.globalmetaid } : {}),
        });
        await deps.sendEncryptedPrivateMessage(metabotId, sellerGlobalMetaId, wireMsg);
        dmSent = true;
      } catch {
        // Non-fatal: seller daemon has 60s ABS polling fallback
      }
    }

    return {
      status: 200,
      body: {
        success: true,
        order: escrowOrder,
        dmSent,
        remainingSpendAmount: consumed.remainingSpendAmount,
        remainingLots: consumed.remainingLots,
      },
    };
  } catch (err) {
    return formatErrorResponse(err);
  }
}

export async function handleFtEscrowGetOrderRoute(
  deps: FtCommerceGatewayDeps,
  orderId: string,
  metabotIdRaw: unknown,
): Promise<GatewayRouteResponse> {
  try {
    const trimmedOrderId = String(orderId || '').trim();
    if (!trimmedOrderId) {
      return { status: 400, body: { success: false, error: 'orderId is required' } };
    }
    const store = deps.getMetabotStore();
    let metabotId = Number(metabotIdRaw);
    if (!Number.isInteger(metabotId) || metabotId <= 0) {
      const firstBot = store.listMetabots()[0];
      if (!firstBot) {
        return { status: 400, body: { success: false, error: 'metabotId query parameter is required' } };
      }
      metabotId = firstBot.id;
    }
    const resolveSigner = deps.resolveEscrowSigner ?? resolveMetabotFtEscrowSigner;
    const signer = resolveSigner(store, metabotId);
    const getOrderFn = deps.getEscrowOrder ?? getFtEscrowOrder;
    const order = await getOrderFn(signer, trimmedOrderId);
    return {
      status: 200,
      body: {
        success: true,
        order,
      },
    };
  } catch (err) {
    return formatErrorResponse(err);
  }
}

export async function handleFtWatchRegisterRoute(
  deps: FtCommerceGatewayDeps,
  rawBody: string,
): Promise<GatewayRouteResponse> {
  const body = parseJsonBody(rawBody);
  if (!body) {
    return { status: 400, body: { success: false, error: 'Invalid JSON object body' } };
  }
  const gate = deps.mandateGate ?? defaultFtMandateGate;
  try {
    // Support both single-lot and batch `lots` array registration
    const rawLots: Array<Record<string, unknown>> = Array.isArray(body.lots)
      ? (body.lots as Array<Record<string, unknown>>)
      : [body];
    const firstLot = rawLots[0] ?? {};

    const metabotId = Number(body.metabotId ?? body.metabot_id ?? firstLot.metabotId ?? firstLot.metabot_id);
    const mandateToken = String(body.mandateToken ?? body.mandate_token ?? '').trim();
    const assetKey = normalizeFtAssetKey(
      body.assetKey ?? body.asset_key ?? firstLot.assetKey ?? firstLot.asset_key,
    );
    const chain: 'mvc' | 'btc' =
      String(body.chain ?? firstLot.chain ?? (assetKey.startsWith('mrc20:') ? 'btc' : 'mvc')).toLowerCase() === 'btc'
        ? 'btc'
        : 'mvc';
    const rail = String(body.rail ?? firstLot.rail ?? '') as FtMandateRail;
    const symbol = String(body.symbol ?? firstLot.symbol ?? 'TOKEN').trim();
    const decimals = Number(body.decimals ?? firstLot.decimals ?? 0) || 0;

    if (mandateToken) {
      gate.consumeMandate({
        mandateToken,
        metabotId,
        action: 'list-lots',
        assetKey,
        rail,
        spendAmount: 0n,
        lots: rawLots.length,
      });
    }

    const store = deps.getMetabotStore();
    const bot = store.getMetabotById(metabotId);
    const batchGroupId =
      String(body.batchGroupId ?? body.batch_group_id ?? '').trim() ||
      `ftbatch_${crypto.randomBytes(8).toString('hex')}`;
    const registered: FtActiveOrderRecord[] = [];

    for (let i = 0; i < rawLots.length; i += 1) {
      const lot = rawLots[i];
      const listingKey =
        String(lot.listingKey ?? lot.listing_key ?? '').trim() ||
        `${batchGroupId}_lot_${i + 1}`;
      const amountBase = String(lot.amountBase ?? lot.amount_base ?? '').trim();
      const amountDisplay =
        String(lot.amountDisplay ?? lot.amount_display ?? '').trim() ||
        formatAtomicDisplay(amountBase, decimals);
      const utxoOutpoint = String(lot.utxoOutpoint ?? lot.utxo_outpoint ?? '').trim();
      const priceSats =
        lot.priceSats !== undefined || lot.price_sats !== undefined
          ? Number(lot.priceSats ?? lot.price_sats)
          : body.priceSats !== undefined
            ? Number(body.priceSats)
            : undefined;
      const priceMeMilli =
        lot.priceMeMilli !== undefined || lot.price_me_milli !== undefined
          ? Number(lot.priceMeMilli ?? lot.price_me_milli)
          : body.priceMeMilli !== undefined
            ? Number(body.priceMeMilli)
            : undefined;
      const autoFulfillMe =
        rail === 'me-escrow'
          ? (lot.autoFulfillMe ?? lot.auto_fulfill_me ?? body.autoFulfillMe ?? true) !== false
          : false;

      let sellPinId = String(lot.sellPinId ?? lot.sell_pin_id ?? '').trim() || undefined;
      if (
        !sellPinId &&
        bot &&
        (lot.broadcastFtSellPin === true || body.broadcastFtSellPin === true)
      ) {
        const feeRate = deps.resolveMvcFeeRate?.() ?? getGlobalFeeRate('mvc');
        const pinPayload: FtSellPinPayloadV1 = {
          version: '1.0',
          active: true,
          listingKey,
          batchGroupId,
          asset: {
            chain,
            standard: chain === 'btc' ? 'mrc20' : 'mvc-ft',
            assetKey,
            symbol,
            decimals,
            ...(lot.codehash || body.codehash ? { codehash: String(lot.codehash ?? body.codehash) } : {}),
            ...(lot.genesis || body.genesis ? { genesis: String(lot.genesis ?? body.genesis) } : {}),
            ...(lot.mrc20Id || body.mrc20Id ? { mrc20Id: String(lot.mrc20Id ?? body.mrc20Id) } : {}),
          },
          lot: {
            amountBase,
            amountDisplay,
            utxoOutpoint,
            lotIndex: i + 1,
            lotTotal: rawLots.length,
          },
          seller: {
            globalMetaId: bot.globalmetaid || '',
            botMvcAddress: bot.mvc_address,
            ...(bot.btc_address ? { botBtcAddress: bot.btc_address } : {}),
          },
          rails:
            rail === 'me-escrow'
              ? {
                  me: {
                    priceMeMilli: priceMeMilli ?? 0,
                    sellerPayeeAddress: bot.mvc_address,
                    autoFulfill: autoFulfillMe,
                  },
                }
              : rail === 'btc-psbt'
                ? {
                    btcPsbt: {
                      priceSats: priceSats ?? 0,
                      ...(lot.marketOrderId ? { marketOrderId: String(lot.marketOrderId) } : {}),
                    },
                  }
                : {},
        };
        validateFtSellPinPayload(pinPayload);
        const pinWriter =
          deps.createChainPin ??
          ((id, payload, fr) => createPin(store, id, payload, { network: 'mvc', feeRate: fr }));
        try {
          const pinRes = await pinWriter(
            metabotId,
            {
              operation: 'create',
              path: '/protocols/ft-sell',
              encryption: '0',
              version: '1.0',
              contentType: 'application/json',
              payload: JSON.stringify(pinPayload),
            },
            feeRate,
          );
          sellPinId = pinRes.pinId;
        } catch {
          // Non-fatal
        }
      }

      const rec = registerFtActiveOrder(
        deps.getDb(),
        {
          listingKey,
          batchGroupId,
          metabotId,
          assetKey,
          chain,
          symbol,
          decimals,
          ...(lot.codehash || body.codehash ? { codehash: String(lot.codehash ?? body.codehash) } : {}),
          ...(lot.genesis || body.genesis ? { genesis: String(lot.genesis ?? body.genesis) } : {}),
          ...(lot.mrc20Id || body.mrc20Id ? { mrc20Id: String(lot.mrc20Id ?? body.mrc20Id) } : {}),
          rail,
          amountBase,
          amountDisplay,
          utxoOutpoint,
          priceSats,
          priceMeMilli,
          autoFulfillMe,
          sellPinId,
          ...(lot.marketOrderId ? { marketOrderId: String(lot.marketOrderId) } : {}),
          ...(lot.tokenSellJson ? { tokenSellJson: String(lot.tokenSellJson) } : {}),
          sellerAddress: chain === 'btc' ? bot?.btc_address : bot?.mvc_address,
          ...(() => {
            const rawSessionId = String(
              lot.sessionId ?? lot.session_id ?? body.sessionId ?? body.session_id ?? '',
            ).trim();
            return rawSessionId ? { sessionId: rawSessionId } : {};
          })(),
        },
        deps.saveDb,
      );
      registered.push(rec);
    }

    return {
      status: 200,
      body: {
        success: true,
        batchGroupId,
        count: registered.length,
        orders: registered,
      },
    };
  } catch (err) {
    return formatErrorResponse(err);
  }
}

export function handleFtWatchListRoute(
  deps: FtCommerceGatewayDeps,
  rawBody: string,
): GatewayRouteResponse {
  const body = parseJsonBody(rawBody || '{}');
  if (!body) {
    return { status: 400, body: { success: false, error: 'Invalid JSON object body' } };
  }
  try {
    const batchGroupId = String(body.batchGroupId ?? body.batch_group_id ?? '').trim();
    if (batchGroupId) {
      const progress = getFtBatchOrderProgress(deps.getDb(), batchGroupId);
      return {
        status: 200,
        body: {
          success: true,
          progress,
        },
      };
    }
    const metabotId = Number(body.metabotId ?? body.metabot_id);
    const status = typeof body.status === 'string' && body.status.trim()
      ? (body.status.trim() as 'active' | 'filled' | 'canceled' | 'expired')
      : undefined;
    const orders = listFtActiveOrders(deps.getDb(), {
      ...(Number.isInteger(metabotId) && metabotId > 0 ? { metabotId } : {}),
      ...(status ? { status } : {}),
    });
    return {
      status: 200,
      body: {
        success: true,
        orders,
      },
    };
  } catch (err) {
    return formatErrorResponse(err);
  }
}
