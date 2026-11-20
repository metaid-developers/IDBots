import type { MobileNativeAdapter } from './nativeAdapter';
import { getNativeAdapter } from './nativeAdapter';

export type PushPermission = 'granted' | 'denied' | 'prompt' | 'unavailable';
export type NotificationCategoryPreference = 'work' | 'action' | 'report' | 'system';
export interface MobilePushPreferences extends Record<NotificationCategoryPreference, boolean> {
  enabled: boolean;
}

export const DEFAULT_PUSH_PREFERENCES: MobilePushPreferences = { enabled: true, work: true, action: true, report: true, system: true };

export interface PushDeviceApi {
  getPreferences(): Promise<{ preferences: MobilePushPreferences; provider: string }>;
  setPreferences(preferences: Partial<MobilePushPreferences>): Promise<MobilePushPreferences>;
  register(input: {
    deviceId: string;
    installationId: string;
    platform: 'android' | 'ios';
    provider: 'fcm';
    token: string;
    appVersion: string | null;
    shellVersion: string | null;
  }): Promise<void>;
  unregister(deviceId: string): Promise<void>;
}

async function request<T>(fetchImpl: typeof fetch, path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<T> {
  const response = await fetchImpl(path, {
    method,
    credentials: 'same-origin',
    signal: AbortSignal.timeout(10_000),
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null) as { error?: { code?: string } } | null;
  if (!response.ok) throw new Error(payload?.error?.code ?? `HTTP_${response.status}`);
  return payload as T;
}

export function createPushDeviceApi(fetchImpl: typeof fetch = fetch): PushDeviceApi {
  return {
    async getPreferences() {
      return request(fetchImpl, '/api/v1/notification-preferences', 'GET');
    },
    async setPreferences(preferences) {
      const result = await request<{ preferences: MobilePushPreferences }>(fetchImpl, '/api/v1/notification-preferences', 'PUT', { preferences });
      return result.preferences;
    },
    async register(input) {
      await request(fetchImpl, '/api/v1/devices/register', 'POST', input);
    },
    async unregister(deviceId) {
      await request(fetchImpl, '/api/v1/devices/unregister', 'POST', { deviceId });
    },
  };
}

interface InstallationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const INSTALLATION_KEY = 'idbots.mobile.installation.v1';

function readInstallation(target: Window): { deviceId: string; installationId: string } {
  let parsed: { deviceId?: unknown; installationId?: unknown } | null = null;
  try {
    const storage = target.localStorage as InstallationStorage;
    const value = storage.getItem(INSTALLATION_KEY);
    if (value) parsed = JSON.parse(value) as { deviceId?: unknown; installationId?: unknown };
    if (typeof parsed?.deviceId === 'string' && typeof parsed.installationId === 'string') {
      return { deviceId: parsed.deviceId, installationId: parsed.installationId };
    }
    const installationId = target.crypto.randomUUID();
    const created = { deviceId: `mobile-${installationId}`, installationId };
    storage.setItem(INSTALLATION_KEY, JSON.stringify(created));
    return created;
  } catch {
    throw new Error('INSTALLATION_ID_UNAVAILABLE');
  }
}

export async function registerCurrentInstallation(
  adapter: MobileNativeAdapter,
  api: PushDeviceApi,
  target: Window,
  appVersion: string | null = null,
): Promise<void> {
  const token = await adapter.registerForPush();
  const installation = readInstallation(target);
  await api.register({
    ...installation,
    platform: target.idbotsMobile?.os === 'ios' ? 'ios' : 'android',
    provider: 'fcm',
    token,
    appVersion,
    shellVersion: null,
  });
}

export async function unregisterCurrentInstallation(api: PushDeviceApi, target: Window): Promise<void> {
  try {
    await api.unregister(readInstallation(target).deviceId);
  } catch {
    // Logout must still proceed if the network or local installation state is unavailable.
  }
}

export interface PushSettingsSnapshot {
  available: boolean;
  permission: PushPermission;
  provider: string;
  preferences: MobilePushPreferences;
  registered: boolean;
  error: string | null;
}

let defaultCoordinator: PushNotificationCoordinator | null = null;

export function getPushNotificationCoordinator(): PushNotificationCoordinator {
  if (!defaultCoordinator) defaultCoordinator = new PushNotificationCoordinator();
  return defaultCoordinator;
}

export class PushNotificationCoordinator {
  private snapshot: PushSettingsSnapshot = {
    available: false,
    permission: 'unavailable',
    provider: 'unknown',
    preferences: { ...DEFAULT_PUSH_PREFERENCES },
    registered: false,
    error: null,
  };

  constructor(
    private adapter: MobileNativeAdapter = getNativeAdapter(),
    private api: PushDeviceApi = createPushDeviceApi(),
    private target: Window = window,
  ) {}

  async load(): Promise<PushSettingsSnapshot> {
    this.snapshot.available = this.adapter.getCapabilities().pushNotifications;
    this.snapshot.error = null;
    if (!this.snapshot.available) return this.state();
    try {
      const [permission, remote] = await Promise.all([this.adapter.getPushPermission(), this.api.getPreferences()]);
      this.snapshot.permission = permission;
      this.snapshot.preferences = remote.preferences;
      this.snapshot.provider = remote.provider;
      if (permission === 'granted' && remote.preferences.enabled && remote.provider === 'fcm') {
        await registerCurrentInstallation(this.adapter, this.api, this.target);
        this.snapshot.registered = true;
      }
    } catch (error) {
      this.snapshot.error = error instanceof Error ? error.message : 'NATIVE_FAILED';
    }
    return this.state();
  }

  async enable(): Promise<PushSettingsSnapshot> {
    this.snapshot.error = null;
    try {
      const permission = await this.adapter.requestPushPermission();
      this.snapshot.permission = permission;
      if (permission !== 'granted') return this.state();
      await registerCurrentInstallation(this.adapter, this.api, this.target);
      this.snapshot.preferences = await this.api.setPreferences({ enabled: true });
      this.snapshot.registered = true;
      this.snapshot.provider = 'fcm';
    } catch (error) {
      this.snapshot.error = error instanceof Error ? error.message : 'NATIVE_FAILED';
    }
    return this.state();
  }

  async update(input: Partial<MobilePushPreferences>): Promise<PushSettingsSnapshot> {
    this.snapshot.error = null;
    try {
      if (input.enabled === true && this.snapshot.permission !== 'granted') return this.enable();
      this.snapshot.preferences = await this.api.setPreferences(input);
      if (input.enabled === false) {
        await unregisterCurrentInstallation(this.api, this.target);
        this.snapshot.registered = false;
      } else if (this.snapshot.permission === 'granted' && this.snapshot.preferences.enabled) {
        await registerCurrentInstallation(this.adapter, this.api, this.target);
        this.snapshot.registered = true;
      }
    } catch (error) {
      this.snapshot.error = error instanceof Error ? error.message : 'NATIVE_FAILED';
    }
    return this.state();
  }

  async openSystemSettings(): Promise<PushSettingsSnapshot> {
    try {
      await this.adapter.openNotificationSettings();
    } catch (error) {
      this.snapshot.error = error instanceof Error ? error.message : 'NATIVE_FAILED';
    }
    return this.state();
  }

  state(): PushSettingsSnapshot {
    return { ...this.snapshot, preferences: { ...this.snapshot.preferences } };
  }
}
