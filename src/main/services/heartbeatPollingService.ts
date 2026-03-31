const HEARTBEAT_ONLINE_WINDOW_SEC = 10 * 60; // 10 minutes
const HEARTBEAT_POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
const MANAPI_HOST = 'https://manapi.metaid.io';

export interface HeartbeatDeps {
  fetchHeartbeat: (mvcAddress: string) => Promise<{ timestamp: number } | null>;
}

export class HeartbeatPollingService {
  private deps: HeartbeatDeps;
  private _onlineBots: Map<string, number> = new Map();
  private _availableServices: any[] = [];
  private _intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(deps: HeartbeatDeps) {
    this.deps = deps;
  }

  get onlineBots(): Map<string, number> {
    return this._onlineBots;
  }

  get availableServices(): any[] {
    return this._availableServices;
  }

  checkOnlineStatus(timestampSec: number | null): boolean {
    if (timestampSec == null) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    return nowSec - timestampSec <= HEARTBEAT_ONLINE_WINDOW_SEC;
  }

  async pollAll(services: any[]): Promise<void> {
    console.log(`[HeartbeatPolling] pollAll: checking ${services.length} services`);
    const nextOnlineBots: Map<string, number> = new Map();
    const nextAvailableServices: any[] = [];

    for (const service of services) {
      const globalMetaId: string = service.providerGlobalMetaId || service.globalMetaId || '';
      const status = Number(service?.status ?? 0);
      if (Number.isFinite(status) && status < 0) {
        console.log(`[HeartbeatPolling] skip revoked service "${service.displayName || service.serviceName}" status=${status}`);
        continue;
      }

      const available = Number(service?.available ?? 1);
      if (Number.isFinite(available) && available === 0) {
        console.log(`[HeartbeatPolling] skip unavailable service "${service.displayName || service.serviceName}" available=${available}`);
        continue;
      }

      const mvcAddress: string = service.providerAddress || service.paymentAddress || service.address || '';
      if (!mvcAddress) {
        console.log(`[HeartbeatPolling] skip service "${service.displayName || service.serviceName}" — no address`);
        continue;
      }

      let heartbeat: { timestamp: number } | null = null;
      try {
        heartbeat = await this.deps.fetchHeartbeat(mvcAddress);
      } catch (err) {
        console.warn(`[HeartbeatPolling] fetch error for ${mvcAddress}:`, err);
      }

      const timestampSec = heartbeat ? heartbeat.timestamp : null;
      const isOnline = this.checkOnlineStatus(timestampSec);
      console.log(`[HeartbeatPolling] "${service.displayName || service.serviceName}" addr=${mvcAddress.slice(0, 10)}... ts=${timestampSec} online=${isOnline}`);

      if (isOnline) {
        if (globalMetaId) {
          nextOnlineBots.set(globalMetaId, timestampSec as number);
        }
        nextAvailableServices.push(service);
      }
    }

    this._onlineBots = nextOnlineBots;
    this._availableServices = nextAvailableServices;
    console.log(`[HeartbeatPolling] result: ${nextOnlineBots.size} online bots, ${nextAvailableServices.length} available services`);
  }

  startPolling(getServices: () => any[]): void {
    console.log('[HeartbeatPolling] startPolling called');
    // Fire immediately
    this.pollAll(getServices()).catch((err) => {
      console.warn('[HeartbeatPolling] initial poll error:', err);
    });

    this._intervalId = setInterval(() => {
      this.pollAll(getServices()).catch((err) => {
        console.warn('[HeartbeatPolling] interval poll error:', err);
      });
    }, HEARTBEAT_POLL_INTERVAL_MS);
  }

  stopPolling(): void {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  markOffline(globalMetaId: string): void {
    this._onlineBots.delete(globalMetaId);
    this._availableServices = this._availableServices.filter(
      (s: any) => (s.providerGlobalMetaId || s.globalMetaId) !== globalMetaId
    );
  }
}

export async function fetchHeartbeatFromChain(
  mvcAddress: string
): Promise<{ timestamp: number } | null> {
  const url = `${MANAPI_HOST}/address/pin/list/${encodeURIComponent(mvcAddress)}?cursor=0&size=1&path=/protocols/metabot-heartbeat`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[HeartbeatPolling] fetch ${url} → ${res.status}`);
      return null;
    }
    const json = await res.json();
    // Handle both response formats: { data: { list: [...] } } and { list: [...] }
    const list = json?.data?.list || json?.list || json?.result?.list;
    if (!Array.isArray(list) || list.length === 0) {
      console.log(`[HeartbeatPolling] no heartbeat pins for ${mvcAddress.slice(0, 10)}...`);
      return null;
    }
    const item = list[0];
    // Use seenTime (broadcast time in seconds), NOT timestamp (genesis time, stale)
    const ts = item?.seenTime ?? item?.seen_time ?? null;
    if (typeof ts !== 'number') {
      console.log(`[HeartbeatPolling] heartbeat pin has no valid seenTime:`, JSON.stringify(item).slice(0, 200));
      return null;
    }
    return { timestamp: ts };
  } catch (err) {
    console.warn(`[HeartbeatPolling] fetchHeartbeatFromChain error for ${mvcAddress}:`, err);
    return null;
  }
}
