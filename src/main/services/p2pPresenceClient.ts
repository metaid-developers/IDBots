import { validateGlobalMetaId } from './globalMetaid';

export interface LocalPresenceBotState {
  lastSeenSec: number;
  expiresAtSec: number;
  peerIds: string[];
}

export interface LocalPresenceSnapshot {
  healthy: boolean;
  peerCount: number;
  onlineBots: Record<string, LocalPresenceBotState>;
  unhealthyReason: string | null;
  lastConfigReloadError: string | null;
  nowSec: number | null;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toOptionalNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizePresenceGlobalMetaId(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith('metaid:')) return null;
  if (!validateGlobalMetaId(normalized)) return null;
  return normalized;
}

function unhealthySnapshot(reason: string): LocalPresenceSnapshot {
  return {
    healthy: false,
    peerCount: 0,
    onlineBots: {},
    unhealthyReason: reason,
    lastConfigReloadError: null,
    nowSec: null,
  };
}

function parseBotState(value: unknown): LocalPresenceBotState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const lastSeenSec = toFiniteNumber(raw.lastSeenSec);
  const expiresAtSec = toFiniteNumber(raw.expiresAtSec);
  const peerIdsRaw = raw.peerIds;

  if (!Array.isArray(peerIdsRaw) || lastSeenSec == null || expiresAtSec == null) {
    return null;
  }

  const peerIds: string[] = [];
  for (const peerId of peerIdsRaw) {
    if (typeof peerId !== 'string') return null;
    const normalized = peerId.trim();
    if (!normalized) continue;
    peerIds.push(normalized);
  }

  return {
    lastSeenSec,
    expiresAtSec,
    peerIds,
  };
}

function normalizeOnlineBots(value: unknown): Record<string, LocalPresenceBotState> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const onlineBots: Record<string, LocalPresenceBotState> = {};
  for (const [key, rawState] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = normalizePresenceGlobalMetaId(key);
    if (!normalizedKey) {
      return null;
    }

    const normalizedState = parseBotState(rawState);
    if (!normalizedState) {
      return null;
    }

    onlineBots[normalizedKey] = normalizedState;
  }

  return onlineBots;
}

export async function fetchLocalPresenceSnapshot(baseUrl: string): Promise<LocalPresenceSnapshot> {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  try {
    const response = await fetch(`${normalizedBase}/api/p2p/presence`, {
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) {
      return unhealthySnapshot('http_not_ok');
    }

    const payload = await response.json() as {
      code?: unknown;
      data?: unknown;
    };

    if (payload?.code !== 1) {
      return unhealthySnapshot('envelope_code_not_success');
    }

    if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
      return unhealthySnapshot('malformed_data');
    }

    const data = payload.data as Record<string, unknown>;
    if (typeof data.healthy !== 'boolean') {
      return unhealthySnapshot('malformed_healthy');
    }

    const peerCount = toFiniteNumber(data.peerCount);
    if (peerCount == null) {
      return unhealthySnapshot('malformed_peer_count');
    }

    const onlineBots = normalizeOnlineBots(data.onlineBots);
    if (!onlineBots) {
      return unhealthySnapshot('malformed_online_bots');
    }

    const unhealthyReason = toOptionalNonEmptyString(data.unhealthyReason);
    const lastConfigReloadError = toOptionalNonEmptyString(data.lastConfigReloadError);
    const nowSec = toFiniteNumber(data.nowSec);

    if (!data.healthy) {
      return {
        healthy: false,
        peerCount,
        onlineBots,
        unhealthyReason: unhealthyReason ?? 'presence_unhealthy',
        lastConfigReloadError,
        nowSec,
      };
    }

    return {
      healthy: true,
      peerCount,
      onlineBots,
      unhealthyReason: null,
      lastConfigReloadError,
      nowSec,
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return unhealthySnapshot('request_timeout');
    }
    return unhealthySnapshot('request_failed');
  }
}
