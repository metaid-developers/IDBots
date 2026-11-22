/**
 * Local RPC Gateway Routes for MVC MetaContract FT (MCP02 v2) Issuance & Minting.
 *
 * Mounted on `metaidRpcServer.ts` (`127.0.0.1`, Bearer-authenticated):
 * - `POST /api/idbots/wallet/mvc/ft/issue`
 * - `POST /api/idbots/wallet/mvc/ft/mint`
 * - `GET  /api/idbots/wallet/mvc/ft/issued`
 *
 * Security & Two-Step Confirmation Protocol:
 * 1. Step 1 (Estimate / Dry-Run or unconfirmed call): builds and sCrypt-verifies
 *    the exact genesis/mint raw transaction(s) locally without broadcasting, and
 *    issues a single-use, 5-minute TTL `confirmationToken` bound to the canonical
 *    digest of `(action, metabotId, tokenName/sensibleId, symbol, decimals, supplyBase,
 *    allowIncreaseMints, receiverAddress)`.
 * 2. Step 2 (Confirmed Broadcast): requires BOTH `ownerConfirmed: true` AND the
 *    matching `confirmationToken` from Step 1. Parameter tampering between Step 1
 *    and Step 2 fails closed with `403 CONFIRMATION_TOKEN_MISMATCH`.
 */

import crypto from 'crypto';
import type { SqliteDatabase as Database } from '../sqliteTypes';
import type { MetabotStore } from '../metabotStore';
import type { BotWalletTransferStore } from './botWalletTransferStore';
import { resolveMetabotIdByName } from './assignGroupChatTaskService';
import { getRate as getGlobalFeeRate } from './feeRateStore';
import type { GatewayRouteResponse } from './ftCommerceGatewayRoutes';
import {
  executeMvcFtIssue,
  executeMvcFtMint,
  findMvcFtIssuanceByToken,
  listMvcFtIssuances,
  parseDisplaySupplyToBase,
  resolveFtReceiverAddress,
  type MvcFtIssueServiceDeps,
} from './mvcFtIssueService';

export const FT_MVC_ISSUE_PATH = '/api/idbots/wallet/mvc/ft/issue';
export const FT_MVC_MINT_PATH = '/api/idbots/wallet/mvc/ft/mint';
export const FT_MVC_ISSUED_LIST_PATH = '/api/idbots/wallet/mvc/ft/issued';

const CONFIRMATION_TOKEN_TTL_MS = 5 * 60 * 1000;

interface ConfirmationTokenRecord {
  token: string;
  digest: string;
  expiresAt: number;
  consumed: boolean;
}

export class MvcFtIssueConfirmationGate {
  private readonly tokens = new Map<string, ConfirmationTokenRecord>();
  private readonly ttlMs: number;
  private readonly nowFn: () => number;

  constructor(options: { ttlMs?: number; nowFn?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? CONFIRMATION_TOKEN_TTL_MS;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  private prune(now: number): void {
    for (const [key, entry] of this.tokens.entries()) {
      if (entry.consumed || entry.expiresAt <= now) {
        this.tokens.delete(key);
      }
    }
  }

  static computeDigest(payload: Record<string, unknown>): string {
    const canonical = JSON.stringify(
      Object.keys(payload)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = payload[key];
          return acc;
        }, {}),
    );
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  issueToken(payload: Record<string, unknown>): { confirmationToken: string; expiresAt: number } {
    const now = this.nowFn();
    this.prune(now);
    const confirmationToken = `ftissue_${crypto.randomBytes(16).toString('hex')}`;
    const digest = MvcFtIssueConfirmationGate.computeDigest(payload);
    const expiresAt = now + this.ttlMs;
    this.tokens.set(confirmationToken, {
      token: confirmationToken,
      digest,
      expiresAt,
      consumed: false,
    });
    return { confirmationToken, expiresAt };
  }

  consumeToken(
    confirmationToken: string,
    expectedPayload: Record<string, unknown>,
  ): { ok: boolean; errorCode?: string; error?: string } {
    const now = this.nowFn();
    const clean = String(confirmationToken || '').trim();
    if (!clean) {
      return {
        ok: false,
        errorCode: 'CONFIRMATION_TOKEN_REQUIRED',
        error:
          'confirmationToken from a prior dryRun/estimate call is required alongside ownerConfirmed=true.',
      };
    }
    const entry = this.tokens.get(clean);
    if (!entry) {
      return {
        ok: false,
        errorCode: 'CONFIRMATION_TOKEN_INVALID',
        error: 'Unknown or expired confirmationToken; run estimate/dryRun again and re-confirm with the owner.',
      };
    }
    if (entry.consumed) {
      return {
        ok: false,
        errorCode: 'CONFIRMATION_TOKEN_REPLAYED',
        error: 'confirmationToken has already been used; run estimate/dryRun again for a new issuance/mint.',
      };
    }
    if (entry.expiresAt <= now) {
      this.tokens.delete(clean);
      return {
        ok: false,
        errorCode: 'CONFIRMATION_TOKEN_EXPIRED',
        error: 'confirmationToken expired (5-minute TTL); run estimate/dryRun again and re-confirm with the owner.',
      };
    }
    const expectedDigest = MvcFtIssueConfirmationGate.computeDigest(expectedPayload);
    if (entry.digest !== expectedDigest) {
      return {
        ok: false,
        errorCode: 'CONFIRMATION_TOKEN_MISMATCH',
        error:
          'Issuance/mint parameters do not match the previewed confirmationToken (name, symbol, decimals, supply, allowIncreaseMints, or receiver changed). Run estimate again.',
      };
    }
    entry.consumed = true;
    this.tokens.delete(clean);
    return { ok: true };
  }
}

export const defaultMvcFtIssueConfirmationGate = new MvcFtIssueConfirmationGate();

export interface MvcFtIssueGatewayDeps {
  getDb: () => Database;
  saveDb?: () => void;
  getMetabotStore: () => MetabotStore;
  getTransferStore?: () => BotWalletTransferStore | null;
  resolveMvcFeeRate?: () => number;
  confirmationGate?: MvcFtIssueConfirmationGate;
  buildIssueRawTx?: MvcFtIssueServiceDeps['buildIssueRawTx'];
  buildMintRawTx?: MvcFtIssueServiceDeps['buildMintRawTx'];
  broadcastTx?: MvcFtIssueServiceDeps['broadcastTx'];
}

function resolveCallerMetabotId(store: MetabotStore, body: Record<string, unknown>): number {
  const rawId = body.metabotId ?? body.metabot_id;
  if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
    const parsed = Number(rawId);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const fromName = String(body.from ?? body.metabotName ?? body.metabot_name ?? '').trim();
  if (fromName) {
    const resolved = resolveMetabotIdByName(store, fromName);
    if (resolved != null) return resolved;
    throw new Error(`Local MetaBot not found by name: "${fromName}"`);
  }
  const first = store.listMetabots()[0];
  if (first?.id) return first.id;
  throw new Error('metabotId (or from MetaBot name) is required');
}

function parseGatewayBody(rawBody: string | Record<string, unknown>): Record<string, unknown> | null {
  if (typeof rawBody === 'string') {
    try {
      const parsed = JSON.parse(rawBody || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)) {
    return rawBody;
  }
  return null;
}

function classifyErrorStatus(message: string): number {
  const lower = message.toLowerCase();
  if (lower.includes('compliance_violation')) return 422;
  if (lower.includes('ft_supply_locked') || lower.includes('ft_supply_fixed')) return 409;
  if (lower.includes('insufficient') || lower.includes('not enough balance')) return 422;
  return 400;
}

export async function handleMvcFtIssueRoute(
  deps: MvcFtIssueGatewayDeps,
  rawBody: string | Record<string, unknown>,
): Promise<GatewayRouteResponse> {
  const body = parseGatewayBody(rawBody);
  if (!body) {
    return { status: 400, body: { success: false, error: 'Invalid JSON body' } };
  }
  try {
    const metabotStore = deps.getMetabotStore();
    const metabotId = resolveCallerMetabotId(metabotStore, body);
    const tokenName = String(body.tokenName ?? body.name ?? body.token_name ?? '').trim();
    const tokenSymbol = String(body.tokenSymbol ?? body.symbol ?? body.token_symbol ?? '').trim();
    const decimals = body.decimals !== undefined ? Number(body.decimals) : 8;
    const initialSupply = String(body.initialSupply ?? body.initial_supply ?? body.supply ?? '').trim();
    const receiver =
      typeof (body.receiver ?? body.receiverAddress ?? body.receiver_address) === 'string'
        ? String(body.receiver ?? body.receiverAddress ?? body.receiver_address).trim() || undefined
        : undefined;
    const allowIncreaseMints = Boolean(body.allowIncreaseMints ?? body.allow_increase_mints ?? false);
    const feeRate = body.feeRate !== undefined || body.fee_rate !== undefined
      ? Number(body.feeRate ?? body.fee_rate)
      : undefined;
    const memo = typeof body.memo === 'string' ? body.memo.trim() || undefined : undefined;
    const dryRun = Boolean(body.dryRun ?? body.dry_run ?? false);
    const ownerConfirmed = Boolean(body.ownerConfirmed ?? body.owner_confirmed ?? false);
    const confirmationToken = String(body.confirmationToken ?? body.confirmation_token ?? '').trim();

    const gate = deps.confirmationGate ?? defaultMvcFtIssueConfirmationGate;
    const serviceDeps: MvcFtIssueServiceDeps = {
      getDb: deps.getDb,
      saveDb: deps.saveDb,
      metabotStore,
      transferStore: deps.getTransferStore?.() ?? null,
      getFeeRate: deps.resolveMvcFeeRate ?? (() => getGlobalFeeRate('mvc')),
      buildIssueRawTx: deps.buildIssueRawTx,
      buildMintRawTx: deps.buildMintRawTx,
      broadcastTx: deps.broadcastTx,
    };

    // Always build dry-run preview first when unconfirmed or dryRun=true so we bind
    // the exact resolved receiverAddress + supplyBase into confirmationToken!
    if (dryRun || !ownerConfirmed) {
      const previewOutcome = await executeMvcFtIssue(serviceDeps, {
        metabotId,
        tokenName,
        tokenSymbol,
        decimals,
        initialSupply,
        receiver,
        allowIncreaseMints,
        feeRate,
        memo,
        dryRun: true,
      });
      const issuedToken = gate.issueToken({
        action: 'issue',
        metabotId,
        tokenName: previewOutcome.tokenName,
        tokenSymbol: previewOutcome.tokenSymbol,
        decimals: previewOutcome.decimals,
        supplyBase: previewOutcome.supplyBase,
        allowIncreaseMints: previewOutcome.allowIncreaseMints,
        receiverAddress: previewOutcome.receiverAddress,
      });
      if (dryRun) {
        return {
          status: 200,
          body: {
            ...previewOutcome,
            confirmationToken: issuedToken.confirmationToken,
            confirmationExpiresAt: issuedToken.expiresAt,
          },
        };
      }
      return {
        status: 409,
        body: {
          ...previewOutcome,
          status: 'confirmation_required',
          success: false,
          errorCode: 'CONFIRMATION_REQUIRED',
          error:
            'Owner confirmation required: show tokenName, tokenSymbol, decimals, supplyDisplay, supplyModel, receiverAddress, and totalFeeSats to the owner, then re-call with ownerConfirmed=true and confirmationToken.',
          confirmationToken: issuedToken.confirmationToken,
          confirmationExpiresAt: issuedToken.expiresAt,
        },
      };
    }

    // Confirmed live execution: validate confirmationToken digest before spawning worker or broadcasting
    const resolvedReceiver = resolveFtReceiverAddress(metabotStore, metabotId, receiver);
    const supplyBase = parseDisplaySupplyToBase(initialSupply, decimals, {
      allowZero: allowIncreaseMints,
      fieldName: 'initialSupply',
    }).toString();
    const tokenCheck = gate.consumeToken(confirmationToken, {
      action: 'issue',
      metabotId,
      tokenName,
      tokenSymbol,
      decimals,
      supplyBase,
      allowIncreaseMints,
      receiverAddress: resolvedReceiver.address,
    });
    if (!tokenCheck.ok) {
      return {
        status: 403,
        body: {
          success: false,
          status: 'confirmation_rejected',
          errorCode: tokenCheck.errorCode,
          error: tokenCheck.error,
        },
      };
    }

    const liveOutcome = await executeMvcFtIssue(serviceDeps, {
      metabotId,
      tokenName,
      tokenSymbol,
      decimals,
      initialSupply,
      receiver,
      allowIncreaseMints,
      feeRate,
      memo,
      dryRun: false,
      ownerConfirmed: true,
      origin: 'rpc:mvc_ft_issue',
    });
    return {
      status: liveOutcome.success ? 200 : 403,
      body: { ...liveOutcome },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: classifyErrorStatus(message),
      body: {
        success: false,
        error: message,
      },
    };
  }
}

export async function handleMvcFtMintRoute(
  deps: MvcFtIssueGatewayDeps,
  rawBody: string | Record<string, unknown>,
): Promise<GatewayRouteResponse> {
  const body = parseGatewayBody(rawBody);
  if (!body) {
    return { status: 400, body: { success: false, error: 'Invalid JSON body' } };
  }
  try {
    const metabotStore = deps.getMetabotStore();
    const metabotId = resolveCallerMetabotId(metabotStore, body);
    const sensibleId = typeof (body.sensibleId ?? body.sensible_id) === 'string'
      ? String(body.sensibleId ?? body.sensible_id).trim() || undefined
      : undefined;
    const genesis = typeof body.genesis === 'string' ? body.genesis.trim() || undefined : undefined;
    const assetKey = typeof (body.assetKey ?? body.asset_key) === 'string'
      ? String(body.assetKey ?? body.asset_key).trim() || undefined
      : undefined;
    const amount = String(body.amount ?? body.mintAmount ?? body.mint_amount ?? '').trim();
    const receiver =
      typeof (body.receiver ?? body.receiverAddress ?? body.receiver_address) === 'string'
        ? String(body.receiver ?? body.receiverAddress ?? body.receiver_address).trim() || undefined
        : undefined;
    const allowIncreaseMints =
      body.allowIncreaseMints !== undefined || body.allow_increase_mints !== undefined || body.keepMintAuthority !== undefined || body.keep_mint_authority !== undefined
        ? Boolean(
            body.allowIncreaseMints ??
              body.allow_increase_mints ??
              body.keepMintAuthority ??
              body.keep_mint_authority,
          )
        : true;
    const feeRate = body.feeRate !== undefined || body.fee_rate !== undefined
      ? Number(body.feeRate ?? body.fee_rate)
      : undefined;
    const memo = typeof body.memo === 'string' ? body.memo.trim() || undefined : undefined;
    const dryRun = Boolean(body.dryRun ?? body.dry_run ?? false);
    const ownerConfirmed = Boolean(body.ownerConfirmed ?? body.owner_confirmed ?? false);
    const confirmationToken = String(body.confirmationToken ?? body.confirmation_token ?? '').trim();

    const gate = deps.confirmationGate ?? defaultMvcFtIssueConfirmationGate;
    const serviceDeps: MvcFtIssueServiceDeps = {
      getDb: deps.getDb,
      saveDb: deps.saveDb,
      metabotStore,
      transferStore: deps.getTransferStore?.() ?? null,
      getFeeRate: deps.resolveMvcFeeRate ?? (() => getGlobalFeeRate('mvc')),
      buildIssueRawTx: deps.buildIssueRawTx,
      buildMintRawTx: deps.buildMintRawTx,
      broadcastTx: deps.broadcastTx,
    };

    if (dryRun || !ownerConfirmed) {
      const previewOutcome = await executeMvcFtMint(serviceDeps, {
        metabotId,
        sensibleId,
        genesis,
        assetKey,
        amount,
        receiver,
        allowIncreaseMints,
        feeRate,
        memo,
        dryRun: true,
      });
      const issuedToken = gate.issueToken({
        action: 'mint',
        metabotId,
        sensibleId: previewOutcome.sensibleId,
        supplyDisplay: previewOutcome.supplyDisplay,
        allowIncreaseMints: previewOutcome.allowIncreaseMints,
        receiverAddress: previewOutcome.receiverAddress,
      });
      if (dryRun) {
        return {
          status: 200,
          body: {
            ...previewOutcome,
            confirmationToken: issuedToken.confirmationToken,
            confirmationExpiresAt: issuedToken.expiresAt,
          },
        };
      }
      return {
        status: 409,
        body: {
          ...previewOutcome,
          status: 'confirmation_required',
          success: false,
          errorCode: 'CONFIRMATION_REQUIRED',
          error:
            'Owner confirmation required: show tokenSymbol, supplyDisplay, allowIncreaseMints, receiverAddress, and totalFeeSats to the owner, then re-call with ownerConfirmed=true and confirmationToken.',
          confirmationToken: issuedToken.confirmationToken,
          confirmationExpiresAt: issuedToken.expiresAt,
        },
      };
    }

    const storedRecord =
      findMvcFtIssuanceByToken(deps.getDb(), { sensibleId, genesis, assetKey, metabotId }) ??
      findMvcFtIssuanceByToken(deps.getDb(), { sensibleId, genesis, assetKey });
    const resolvedSensibleId = String(sensibleId || storedRecord?.sensibleId || '').trim().toLowerCase();
    const resolvedReceiver = resolveFtReceiverAddress(metabotStore, metabotId, receiver);
    // Normalize display string identically to formatBaseSupplyToDisplay (strip trailing fractional zeros)
    const normalizedAmountDisplay = (() => {
      if (!/^\d+(?:\.\d+)?$/.test(amount)) return amount;
      const [ip, fp = ''] = amount.split('.');
      const strippedInt = ip.replace(/^0+(?=\d)/, '');
      const strippedFrac = fp.replace(/0+$/, '');
      return strippedFrac ? `${strippedInt}.${strippedFrac}` : strippedInt;
    })();
    const tokenCheck = gate.consumeToken(confirmationToken, {
      action: 'mint',
      metabotId,
      sensibleId: resolvedSensibleId,
      supplyDisplay: normalizedAmountDisplay,
      allowIncreaseMints,
      receiverAddress: resolvedReceiver.address,
    });
    if (!tokenCheck.ok) {
      return {
        status: 403,
        body: {
          success: false,
          status: 'confirmation_rejected',
          errorCode: tokenCheck.errorCode,
          error: tokenCheck.error,
        },
      };
    }

    const liveOutcome = await executeMvcFtMint(serviceDeps, {
      metabotId,
      sensibleId,
      genesis,
      assetKey,
      amount,
      receiver,
      allowIncreaseMints,
      feeRate,
      memo,
      dryRun: false,
      ownerConfirmed: true,
      origin: 'rpc:mvc_ft_mint',
    });
    return {
      status: liveOutcome.success ? 200 : 403,
      body: { ...liveOutcome },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: classifyErrorStatus(message),
      body: {
        success: false,
        error: message,
      },
    };
  }
}

export function handleMvcFtIssuedListRoute(
  deps: MvcFtIssueGatewayDeps,
  queryParams: URLSearchParams,
): GatewayRouteResponse {
  try {
    const metabotStore = deps.getMetabotStore();
    let metabotId: number | undefined;
    const rawId = queryParams.get('metabotId') ?? queryParams.get('metabot_id');
    const rawFrom = queryParams.get('from') ?? queryParams.get('metabotName') ?? queryParams.get('metabot_name');
    if (rawId && /^\d+$/.test(rawId.trim())) {
      metabotId = Number(rawId.trim());
    } else if (rawFrom && rawFrom.trim()) {
      const resolved = resolveMetabotIdByName(metabotStore, rawFrom.trim());
      if (resolved == null) {
        return {
          status: 404,
          body: { success: false, error: `Local MetaBot not found by name: "${rawFrom.trim()}"` },
        };
      }
      metabotId = resolved;
    }

    const records = listMvcFtIssuances(deps.getDb(), {
      metabotId,
      assetKey: queryParams.get('assetKey') ?? queryParams.get('asset_key') ?? undefined,
      sensibleId: queryParams.get('sensibleId') ?? queryParams.get('sensible_id') ?? undefined,
      symbol: queryParams.get('symbol') ?? undefined,
      limit: queryParams.get('limit') ? Number(queryParams.get('limit')) : 50,
    }).map((rec) => {
      // Omit bulky raw tx hexes from list responses while preserving all identifiers
      const { genesisTxHex: _gHex, continuationGenesisTxHex: _cHex, ...summary } = rec;
      return summary;
    });

    return {
      status: 200,
      body: {
        success: true,
        count: records.length,
        tokens: records,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 400,
      body: { success: false, error: message },
    };
  }
}
