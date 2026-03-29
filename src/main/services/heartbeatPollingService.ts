const HEARTBEAT_ONLINE_WINDOW_SEC = 6 * 60; // 6 minutes
const HEARTBEAT_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
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
    const nowSec = Date.now() / 1000;
    return nowSec - timestampSec <= HEARTBEAT_ONLINE_WINDOW_SEC;
  }

  async pollAll(services: any[]): Promise<void> {
    const nextOnlineBots: Map<string, number> = new Map();
    const nextAvailableServices: any[] = [];

    for (const service of services) {
      const globalMetaId: string = service.providerGlobalMetaId || service.globalMetaId || '';
      const mvcAddress: string = service.providerAddress || service.paymentAddress || service.address || '';
      if (!mvcAddress) continue;

      let heartbeat: { timestamp: number } | null = null;
      try {
        heartbeat = await this.deps.fetchHeartbeat(mvcAddress);
      } catch {
        // treat as offline on fetch error
      }

      const timestampSec = heartbeat ? heartbeat.timestamp : null;
      if (this.checkOnlineStatus(timestampSec)) {
        if (globalMetaId) {
          nextOnlineBots.set(globalMetaId, timestampSec as number);
        }
        nextAvailableServices.push(service);
      }
    }

    this._onlineBots = nextOnlineBots;
    this._availableServices = nextAvailableServices;
  }

  startPolling(getServices: () => any[]): void {
    // Fire immediately
    this.pollAll(getServices()).catch(() => {});

    this._intervalId = setInterval(() => {
      this.pollAll(getServices()).catch(() => {});
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
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: { list?: Array<{ timestamp?: number }> } };
  const list = json?.data?.list;
  if (!Array.isArray(list) || list.length === 0) return null;
  const item = list[0];
  const ts = item?.timestamp;
  if (typeof ts !== 'number') return null;
  return { timestamp: ts };
}
