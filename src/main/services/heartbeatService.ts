/**
 * HeartbeatService: manages per-MetaBot periodic heartbeat pins.
 *
 * Fires createPin immediately on start, then every 5 minutes, broadcasting
 * on-chain presence via /protocols/metabot-heartbeat.
 *
 * Uses dependency injection for testability.
 */

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const HEARTBEAT_PIN_DATA = {
  path: '/protocols/metabot-heartbeat',
  contentType: 'text/plain',
  payload: '',
  operation: 'create' as const,
  version: '1.0.0',
  encryption: '0' as const,
};

export type CreatePinFn = (
  metabotStore: any,
  metabotId: number,
  metaidData: any,
  options?: { feeRate?: number; network?: string }
) => Promise<{ txids: string[]; pinId: string; totalCost: number }>;

export interface HeartbeatServiceDeps {
  createPin: CreatePinFn;
  getMetabotStore?: () => unknown;
  onHeartbeatSuccess?: (input: { metabotId: number; pinId: string; timestampSec: number }) => void;
}

export class HeartbeatService {
  private readonly timers = new Map<number, ReturnType<typeof setInterval>>();
  private readonly deps: HeartbeatServiceDeps;

  constructor(deps: HeartbeatServiceDeps) {
    this.deps = deps;
  }

  /**
   * Start heartbeat for a MetaBot. Fires immediately, then every 5 minutes.
   * If a heartbeat is already running for this metabotId, it is replaced.
   */
  startHeartbeat(metabotId: number): void {
    // Stop any existing timer for this metabotId
    this.stopHeartbeat(metabotId);

    const fire = async () => {
      const metabotStore = this.deps.getMetabotStore ? this.deps.getMetabotStore() : null;
      try {
        const result = await this.deps.createPin(
          metabotStore,
          metabotId,
          HEARTBEAT_PIN_DATA,
          { network: 'mvc' }
        );
        this.deps.onHeartbeatSuccess?.({
          metabotId,
          pinId: result.pinId,
          timestampSec: Math.floor(Date.now() / 1000),
        });
      } catch (err) {
        console.error(`[HeartbeatService] metabot ${metabotId} heartbeat failed:`, err);
      }
    };

    // Fire immediately (do not await — timer runs independently)
    void fire();

    // Schedule recurring timer
    const timer = setInterval(() => void fire(), HEARTBEAT_INTERVAL_MS);
    this.timers.set(metabotId, timer);
  }

  /**
   * Stop the heartbeat for a specific MetaBot. No-op if not active.
   */
  stopHeartbeat(metabotId: number): void {
    const timer = this.timers.get(metabotId);
    if (timer !== undefined) {
      clearInterval(timer);
      this.timers.delete(metabotId);
    }
  }

  /**
   * Stop all active heartbeat timers.
   */
  stopAll(): void {
    for (const [metabotId, timer] of this.timers) {
      clearInterval(timer);
      this.timers.delete(metabotId);
    }
  }

  /**
   * Returns the number of currently active heartbeat timers.
   */
  activeCount(): number {
    return this.timers.size;
  }

  /**
   * Returns true if a heartbeat timer is active for the given metabotId.
   */
  isActive(metabotId: number): boolean {
    return this.timers.has(metabotId);
  }
}
