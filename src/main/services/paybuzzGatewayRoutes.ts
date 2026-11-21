/**
 * Local RPC Gateway Route Handlers for PayBuzz (/protocols/paybuzz)
 *
 * Mounted on `metaidRpcServer.ts` (`127.0.0.1` + Bearer token protected):
 * - `POST /api/metaid/paybuzz/publish`
 * - `POST /api/metaid/paybuzz/unlock`
 * - `GET  /api/metaid/paybuzz/item?pinId=...&metabotId=...`
 * - `GET  /api/metaid/paybuzz/unlocked?pinId=...`
 */

import type { GatewayRouteResponse } from './ftCommerceGatewayRoutes';
import {
  fetchPaybuzzItem,
  findMatchingVipNftHolding,
  publishPaybuzzArticle,
  unlockPaybuzzArticle,
  type PaybuzzServiceDeps,
  type PaybuzzUnlockRules,
} from './paybuzzService';
import { getPaybuzzUnlockedCache } from './paybuzzStore';

export const PAYBUZZ_PUBLISH_PATH = '/api/metaid/paybuzz/publish';
export const PAYBUZZ_UNLOCK_PATH = '/api/metaid/paybuzz/unlock';
export const PAYBUZZ_ITEM_PATH = '/api/metaid/paybuzz/item';
export const PAYBUZZ_UNLOCKED_PATH = '/api/metaid/paybuzz/unlocked';

function parseJsonBody(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawBody || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function handlePaybuzzPublishRoute(
  deps: PaybuzzServiceDeps,
  rawBody: string,
): Promise<GatewayRouteResponse> {
  const body = parseJsonBody(rawBody);
  if (!body) {
    return { status: 400, body: { success: false, error: 'Invalid JSON object body' } };
  }
  try {
    const metabotId = Number(body.metabotId ?? body.metabot_id);
    const title = String(body.title ?? '').trim();
    const markdown = String(body.markdown ?? body.content ?? '');
    const preview = typeof body.preview === 'string' ? body.preview : undefined;
    const wordCount =
      body.wordCount !== undefined || body.word_count !== undefined
        ? Number(body.wordCount ?? body.word_count)
        : undefined;
    const unlockRules = (body.unlockRules ?? body.unlock_rules) as Partial<PaybuzzUnlockRules> | undefined;
    const networkRaw = typeof body.network === 'string' ? body.network.trim().toLowerCase() : undefined;
    const network =
      networkRaw === 'btc' || networkRaw === 'doge' || networkRaw === 'mvc'
        ? (networkRaw as 'btc' | 'doge' | 'mvc')
        : undefined;

    const result = await publishPaybuzzArticle(deps, {
      metabotId,
      title,
      markdown,
      preview,
      wordCount,
      unlockRules,
      network,
    });
    return {
      status: 200,
      body: {
        success: true,
        ...result,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
    const isClient = /required|invalid|must be|not found|at least one/i.test(message);
    return {
      status: isClient ? 400 : 500,
      body: { success: false, error: message },
    };
  }
}

export async function handlePaybuzzUnlockRoute(
  deps: PaybuzzServiceDeps,
  rawBody: string,
): Promise<GatewayRouteResponse> {
  const body = parseJsonBody(rawBody);
  if (!body) {
    return { status: 400, body: { success: false, error: 'Invalid JSON object body' } };
  }
  try {
    const paybuzzPinId = String(body.paybuzzPinId ?? body.paybuzz_pin_id ?? body.pinId ?? body.pin_id ?? '').trim();
    const metabotId =
      body.metabotId !== undefined || body.metabot_id !== undefined
        ? Number(body.metabotId ?? body.metabot_id)
        : undefined;
    const preferredTrackRaw = String(body.preferredTrack ?? body.preferred_track ?? body.track ?? 'auto').trim();
    const preferredTrack: 'auto' | 'vip-nft' | 'token' =
      preferredTrackRaw === 'vip-nft' || preferredTrackRaw === 'token' ? preferredTrackRaw : 'auto';
    const assetKey = typeof (body.assetKey ?? body.asset_key) === 'string'
      ? String(body.assetKey ?? body.asset_key)
      : undefined;
    const paymentTxId = typeof (body.paymentTxId ?? body.payment_tx_id) === 'string'
      ? String(body.paymentTxId ?? body.payment_tx_id)
      : undefined;
    const confirmTokenPay = (body.confirmTokenPay ?? body.confirm_token_pay) === true;
    const waitTimeoutMs =
      body.waitTimeoutMs !== undefined || body.wait_timeout_ms !== undefined
        ? Number(body.waitTimeoutMs ?? body.wait_timeout_ms)
        : undefined;

    const result = await unlockPaybuzzArticle(deps, {
      paybuzzPinId,
      metabotId,
      preferredTrack,
      assetKey,
      paymentTxId,
      confirmTokenPay,
      waitTimeoutMs,
    });
    return {
      status: 200,
      body: {
        success: true,
        ...result,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
    const isClient = /required|invalid|unsupported|not found|no eligible/i.test(message);
    return {
      status: isClient ? 400 : 500,
      body: { success: false, error: message },
    };
  }
}

export async function handlePaybuzzItemGetRoute(
  deps: PaybuzzServiceDeps,
  paybuzzPinId: string,
  metabotIdRaw?: string | null,
): Promise<GatewayRouteResponse> {
  const pinId = String(paybuzzPinId ?? '').trim().toLowerCase();
  if (!pinId) {
    return { status: 400, body: { success: false, error: 'pinId query param is required' } };
  }
  try {
    const item = await fetchPaybuzzItem(deps, pinId);
    if (!item) {
      return { status: 404, body: { success: false, error: `PayBuzz item ${pinId} not found` } };
    }
    const unlocked = getPaybuzzUnlockedCache(deps.getDb(), pinId);
    let vipMatch: { collectionPinId: string; collectionName: string; itemCount: number } | null = null;
    if (!unlocked && item.unlockRules.vipMrc721Collections.length > 0) {
      const store = deps.getMetabotStore();
      const metabots = store.listMetabots().filter((m) => m.enabled !== false);
      const bot = metabotIdRaw && Number(metabotIdRaw) > 0
        ? store.getMetabotById(Number(metabotIdRaw))
        : metabots.find((m) => m.metabot_type === 'twin') ?? metabots[0] ?? null;
      if (bot?.mvc_address) {
        try {
          vipMatch = await findMatchingVipNftHolding(deps, {
            holderAddress: bot.mvc_address,
            collections: item.unlockRules.vipMrc721Collections,
          });
        } catch {
          vipMatch = null;
        }
      }
    }

    return {
      status: 200,
      body: {
        success: true,
        item,
        unlocked: unlocked ?? null,
        vipMatch,
      },
    };
  } catch (err) {
    return {
      status: 500,
      body: { success: false, error: err instanceof Error ? err.message : String(err ?? 'Unknown error') },
    };
  }
}

export function handlePaybuzzUnlockedGetRoute(
  deps: PaybuzzServiceDeps,
  paybuzzPinId: string,
): GatewayRouteResponse {
  const pinId = String(paybuzzPinId ?? '').trim().toLowerCase();
  if (!pinId) {
    return { status: 400, body: { success: false, error: 'pinId query param is required' } };
  }
  const unlocked = getPaybuzzUnlockedCache(deps.getDb(), pinId);
  if (!unlocked) {
    return { status: 404, body: { success: false, error: `PayBuzz article ${pinId} is not unlocked locally` } };
  }
  return {
    status: 200,
    body: {
      success: true,
      unlocked,
    },
  };
}
