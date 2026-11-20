import type Database from 'better-sqlite3';
import { decryptSecret, encryptSecret } from '../crypto.js';
import type { ControlPlaneConfig } from '../config.js';
import { createPushProvider, PushProviderError, type AgentPushEvent, type PushProvider } from './pushProviders.js';

export interface NotificationPreferences {
  enabled: boolean;
  work: boolean;
  action: boolean;
  report: boolean;
  system: boolean;
}

const DEFAULT_PREFERENCES: NotificationPreferences = { enabled: true, work: true, action: true, report: true, system: true };

interface DeliveryRow {
  event_id: string;
  device_id: string;
  event_json: string;
  token_enc: string;
  provider: string;
  attempts: number;
}

export class PushDeliveryService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private delivering = false;

  constructor(
    private db: Database.Database,
    private config: ControlPlaneConfig,
    private providers: Record<string, PushProvider> = config.push.provider === 'disabled'
      ? {}
      : { [config.push.provider]: createPushProvider(config.push)! },
    private now: () => number = Date.now,
  ) {}

  register(userId: string, input: {
    deviceId: string;
    installationId: string;
    platform: 'android' | 'ios';
    provider: string;
    token: string;
    appVersion: string | null;
    shellVersion: string | null;
  }): void {
    const now = this.now();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM user_devices WHERE user_id = ? AND installation_id = ? AND device_id <> ?')
        .run(userId, input.installationId, input.deviceId);
      this.db.prepare(`
        INSERT INTO user_devices
          (device_id, user_id, installation_id, platform, provider, token_enc, app_version, shell_version, enabled, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          installation_id = excluded.installation_id,
          platform = excluded.platform,
          provider = excluded.provider,
          token_enc = excluded.token_enc,
          app_version = excluded.app_version,
          shell_version = excluded.shell_version,
          enabled = 1,
          last_seen_at = excluded.last_seen_at
        WHERE user_devices.user_id = excluded.user_id
      `).run(
        input.deviceId, userId, input.installationId, input.platform, input.provider,
        encryptSecret(this.config.masterKey, input.token), input.appVersion, input.shellVersion, now, now,
      );
      const saved = this.db.prepare('SELECT user_id FROM user_devices WHERE device_id = ?').get(input.deviceId) as { user_id: string } | undefined;
      if (saved?.user_id !== userId) throw new Error('DEVICE_ID_CONFLICT');
    })();
  }

  unregister(userId: string, deviceId: string): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE user_devices SET enabled = 0, last_seen_at = ? WHERE user_id = ? AND device_id = ?')
        .run(this.now(), userId, deviceId);
      this.db.prepare("UPDATE push_deliveries SET state = 'cancelled', claimed_at = NULL, updated_at = ? WHERE device_id = ? AND state IN ('pending', 'retry', 'sending')")
        .run(this.now(), deviceId);
    })();
  }

  preferences(userId: string): NotificationPreferences {
    const row = this.db.prepare('SELECT enabled, work, action, report, system FROM notification_preferences WHERE user_id = ?').get(userId) as
      | Record<keyof NotificationPreferences, number> | undefined;
    return row ? Object.fromEntries(Object.keys(DEFAULT_PREFERENCES).map((key) => [key, row[key as keyof NotificationPreferences] === 1])) as unknown as NotificationPreferences : { ...DEFAULT_PREFERENCES };
  }

  setPreferences(userId: string, preferences: NotificationPreferences): void {
    this.db.prepare(`
      INSERT INTO notification_preferences (user_id, enabled, work, action, report, system, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, work = excluded.work,
        action = excluded.action, report = excluded.report, system = excluded.system, updated_at = excluded.updated_at
    `).run(userId, preferences.enabled ? 1 : 0, preferences.work ? 1 : 0, preferences.action ? 1 : 0, preferences.report ? 1 : 0, preferences.system ? 1 : 0, this.now());
  }

  async ingest(tenantId: string, event: AgentPushEvent): Promise<{ eventId: string; devices: number; duplicate: boolean }> {
    const tenant = this.db.prepare('SELECT user_id FROM tenants WHERE id = ?').get(tenantId) as { user_id: string } | undefined;
    if (!tenant) throw new Error('TENANT_NOT_FOUND');
    const existing = this.db.prepare('SELECT COUNT(*) AS count FROM push_deliveries WHERE event_id = ?').get(event.eventId) as { count: number };
    const devices = this.db.prepare(`
      SELECT d.device_id FROM user_devices d
      LEFT JOIN notification_preferences p ON p.user_id = d.user_id
      WHERE d.user_id = ? AND d.enabled = 1
        AND COALESCE(p.enabled, 1) = 1
        AND CASE ? WHEN 'work' THEN COALESCE(p.work, 1) WHEN 'action' THEN COALESCE(p.action, 1)
          WHEN 'report' THEN COALESCE(p.report, 1) ELSE COALESCE(p.system, 1) END = 1
    `).all(tenant.user_id, event.category) as Array<{ device_id: string }>;
    const now = this.now();
    this.db.transaction(() => {
      for (const device of devices) {
        this.db.prepare(`INSERT OR IGNORE INTO push_deliveries
          (event_id, device_id, event_json, state, attempts, next_attempt_at, created_at, updated_at)
          VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`)
          .run(event.eventId, device.device_id, JSON.stringify(event), now, now, now);
      }
    })();
    await this.deliverDue(event.eventId);
    return {
      eventId: event.eventId,
      devices: devices.length,
      duplicate: existing.count > 0,
    };
  }

  private async deliverRow(row: DeliveryRow): Promise<void> {
    const provider = this.providers[row.provider];
    const now = this.now();
    if (!provider) {
      this.db.prepare("UPDATE push_deliveries SET state = 'disabled', claimed_at = NULL, last_error = 'PROVIDER_NOT_CONFIGURED', updated_at = ? WHERE event_id = ? AND device_id = ? AND state = 'sending'")
        .run(now, row.event_id, row.device_id);
      return;
    }
    try {
      const event = JSON.parse(row.event_json) as AgentPushEvent;
      const result = await provider.send({ token: decryptSecret(this.config.masterKey, row.token_enc), event });
      this.db.prepare("UPDATE push_deliveries SET state = 'sent', attempts = attempts + 1, claimed_at = NULL, provider_message_id = ?, last_error = NULL, updated_at = ? WHERE event_id = ? AND device_id = ? AND state = 'sending'")
        .run(result.messageId.slice(0, 500), now, row.event_id, row.device_id);
    } catch (error) {
      const providerError = error instanceof PushProviderError ? error : new PushProviderError('PROVIDER_FAILED', true);
      if (providerError.invalidToken) {
        this.db.transaction(() => {
          this.db.prepare('UPDATE user_devices SET enabled = 0 WHERE device_id = ?').run(row.device_id);
          this.db.prepare("UPDATE push_deliveries SET state = 'invalid', attempts = attempts + 1, claimed_at = NULL, last_error = ?, updated_at = ? WHERE event_id = ? AND device_id = ? AND state = 'sending'")
            .run(providerError.errorClass, now, row.event_id, row.device_id);
        })();
        return;
      }
      const attempts = row.attempts + 1;
      const retry = providerError.retryable && attempts < 8;
      const delay = Math.min(15_000 * 2 ** (attempts - 1), 15 * 60_000);
      this.db.prepare(`UPDATE push_deliveries SET state = ?, attempts = ?, claimed_at = NULL,
        next_attempt_at = ?, last_error = ?, updated_at = ? WHERE event_id = ? AND device_id = ? AND state = 'sending'`)
        .run(retry ? 'retry' : 'failed', attempts, now + (retry ? delay : 0), providerError.errorClass, now, row.event_id, row.device_id);
    }
  }

  async deliverDue(eventId?: string): Promise<void> {
    const now = this.now();
    this.db.prepare("UPDATE push_deliveries SET state = 'retry', claimed_at = NULL WHERE state = 'sending' AND claimed_at < ?").run(now - 30_000);
    const rows = this.db.prepare(`
      SELECT d.event_id, d.device_id, d.event_json, d.attempts, u.token_enc, u.provider
      FROM push_deliveries d JOIN user_devices u ON u.device_id = d.device_id
      WHERE d.state IN ('pending', 'retry') AND d.next_attempt_at <= ? AND u.enabled = 1
        AND (? IS NULL OR d.event_id = ?)
      ORDER BY d.next_attempt_at ASC, d.device_id ASC LIMIT 100
    `).all(now, eventId ?? null, eventId ?? null) as DeliveryRow[];
    for (const row of rows) {
      const claimed = this.db.prepare("UPDATE push_deliveries SET state = 'sending', claimed_at = ?, updated_at = ? WHERE event_id = ? AND device_id = ? AND state IN ('pending', 'retry')")
        .run(now, now, row.event_id, row.device_id);
      if (claimed.changes === 1) await this.deliverRow(row);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.delivering) return;
      this.delivering = true;
      void this.deliverDue().finally(() => { this.delivering = false; });
    }, 15_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
