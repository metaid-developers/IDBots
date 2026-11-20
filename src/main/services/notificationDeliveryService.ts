import type { NotificationDeliveryItem, NotificationStore } from '../notificationStore';
import { readCreditPullConfig, type CreditPullConfig } from './creditPullService';

export const NOTIFICATION_DELIVERY_INTERVAL_MS = 15_000;
export const NOTIFICATION_RETRY_BASE_MS = 15_000;
export const NOTIFICATION_RETRY_MAX_MS = 5 * 60_000;

interface DeliveryStore {
  claimPendingOutbox(now: number, limit?: number): NotificationDeliveryItem[];
  markOutboxDelivered(eventId: string): void;
  retryOutbox(eventId: string, error: string, nextAttemptAt: number): void;
}

export interface NotificationDeliveryResult {
  accepted: string[];
  failed: string[];
  skipped?: string;
}

export interface NotificationDeliveryOptions {
  store: DeliveryStore;
  config?: CreditPullConfig | null;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export async function runNotificationDeliveryOnce(options: NotificationDeliveryOptions): Promise<NotificationDeliveryResult> {
  const config = options.config === undefined ? readCreditPullConfig(options.env ?? process.env) : options.config;
  if (!config) return { accepted: [], failed: [], skipped: 'control-plane URL or tenant credentials missing' };
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((level, msg, extra) => console[level](JSON.stringify({ component: 'notification-delivery', msg, ...extra })));
  const result: NotificationDeliveryResult = { accepted: [], failed: [] };
  for (const item of options.store.claimPendingOutbox(now())) {
    try {
      const response = await fetchImpl(
        `${config.controlPlaneUrl}/internal/v1/tenants/${encodeURIComponent(config.tenantId)}/notifications`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${config.gatewaySecret}`,
            'x-tenant-id': config.tenantId,
          },
          body: JSON.stringify(item),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.status !== 202) throw new Error(`control plane answered ${response.status}`);
      options.store.markOutboxDelivered(item.eventId);
      result.accepted.push(item.eventId);
    } catch (error) {
      const message = errorMessage(error);
      const delay = Math.min(NOTIFICATION_RETRY_BASE_MS * 2 ** item.attemptCount, NOTIFICATION_RETRY_MAX_MS);
      options.store.retryOutbox(item.eventId, message, now() + delay);
      result.failed.push(item.eventId);
      log('warn', 'notification delivery failed; retry remains persisted', { eventId: item.eventId, error: message });
    }
  }
  return result;
}

export interface NotificationDeliveryLoop {
  runNow(): Promise<NotificationDeliveryResult>;
  stop(): void;
}

export function startNotificationDeliveryLoop(
  store: NotificationStore,
  options: Omit<NotificationDeliveryOptions, 'store'> & { intervalMs?: number } = {},
): NotificationDeliveryLoop {
  let stopped = false;
  let running: Promise<NotificationDeliveryResult> | null = null;
  const tick = (): Promise<NotificationDeliveryResult> => {
    if (stopped) return Promise.resolve({ accepted: [], failed: [], skipped: 'stopped' });
    if (running) return running;
    running = runNotificationDeliveryOnce({ ...options, store }).finally(() => { running = null; });
    return running;
  };
  const timer = setInterval(() => { void tick(); }, options.intervalMs ?? NOTIFICATION_DELIVERY_INTERVAL_MS);
  timer.unref?.();
  void tick();
  return {
    runNow: tick,
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
