import assert from 'node:assert/strict';
import test from 'node:test';
import type { MobileNativeAdapter } from '../src/mobile/native/nativeAdapter.ts';
import {
  DEFAULT_PUSH_PREFERENCES,
  PushNotificationCoordinator,
  registerCurrentInstallation,
  type MobilePushPreferences,
  type PushDeviceApi,
} from '../src/mobile/native/pushNotifications.ts';

function fixture(permission: 'granted' | 'denied' | 'prompt' = 'prompt') {
  const registrations: Array<Record<string, unknown>> = [];
  const unregistered: string[] = [];
  const updates: Array<Partial<MobilePushPreferences>> = [];
  const storage = new Map<string, string>();
  let requests = 0;
  let token = 0;
  let preferences = { ...DEFAULT_PUSH_PREFERENCES };
  const adapter = {
    getCapabilities: () => ({ pushNotifications: true }),
    getPushPermission: async () => permission,
    requestPushPermission: async () => {
      requests += 1;
      if (permission === 'prompt') permission = 'granted';
      return permission;
    },
    registerForPush: async () => {
      token += 1;
      return `provider-token-${token}`;
    },
  } as unknown as MobileNativeAdapter;
  const api: PushDeviceApi = {
    getPreferences: async () => ({ preferences, provider: 'fcm' }),
    setPreferences: async (input) => {
      updates.push(input);
      preferences = { ...preferences, ...input };
      return preferences;
    },
    register: async (input) => { registrations.push({ ...input }); },
    unregister: async (deviceId) => { unregistered.push(deviceId); },
  };
  const target = {
    idbotsMobile: { isMobile: true, os: 'android', shell: 'capacitor' },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
  } as unknown as Window;
  return { registrations, unregistered, updates, storage, adapter, api, target, requestCount: () => requests };
}

test('cold loading never requests permission and granted devices register a token without storing it', async () => {
  const first = fixture('prompt');
  const pending = new PushNotificationCoordinator(first.adapter, first.api, first.target);
  assert.equal((await pending.load()).registered, false);
  assert.equal(first.requestCount(), 0);
  assert.equal(first.registrations.length, 0);

  const granted = fixture('granted');
  const ready = new PushNotificationCoordinator(granted.adapter, granted.api, granted.target);
  const snapshot = await ready.load();
  assert.equal(snapshot.registered, true);
  assert.equal(granted.requestCount(), 0);
  assert.equal(granted.registrations[0]?.token, 'provider-token-1');
  assert.equal(granted.registrations[0]?.provider, 'fcm');
  assert.equal(granted.registrations[0]?.deviceId, 'mobile-11111111-1111-4111-8111-111111111111');
  assert.equal([...first.storage.values()].some((value) => value.includes('provider-token')), false);
  assert.equal([...granted.storage.values()].some((value) => value.includes('provider-token')), false);
});

test('explicit enable requests permission, updates the master preference, and disable revokes the device', async () => {
  const fake = fixture('prompt');
  const coordinator = new PushNotificationCoordinator(fake.adapter, fake.api, fake.target);
  await coordinator.load();
  assert.equal((await coordinator.enable()).registered, true);
  assert.equal(fake.requestCount(), 1);
  assert.deepEqual(fake.updates, [{ enabled: true }]);
  await coordinator.update({ work: false });
  assert.equal(fake.registrations.length, 2);
  assert.equal(fake.registrations[0]?.installationId, fake.registrations[1]?.installationId);
  assert.equal((await coordinator.update({ enabled: false })).registered, false);
  assert.deepEqual(fake.unregistered, ['mobile-11111111-1111-4111-8111-111111111111']);
});

test('denied permission never registers and registration retry preserves the installation ID', async () => {
  const denied = fixture('denied');
  const coordinator = new PushNotificationCoordinator(denied.adapter, denied.api, denied.target);
  assert.equal((await coordinator.enable()).registered, false);
  assert.equal(denied.registrations.length, 0);

  const fake = fixture('granted');
  await registerCurrentInstallation(fake.adapter, fake.api, fake.target, '1.2.0');
  await registerCurrentInstallation(fake.adapter, fake.api, fake.target, '1.2.0');
  assert.equal(fake.registrations[0]?.deviceId, fake.registrations[1]?.deviceId);
  assert.equal(fake.registrations[0]?.token, 'provider-token-1');
  assert.equal(fake.registrations[1]?.token, 'provider-token-2');
});
