import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { api, freshDb, seedUserAndTenant, startTestApp, MASTER_KEY } from './helpers.js';
import { sha256Hex, decryptSecret } from '../src/crypto.js';
import { FakePushProvider, PushProviderError, FcmPushProvider } from '../src/services/pushProviders.js';

async function setup(t: test.TestContext) {
  const db = freshDb();
  seedUserAndTenant(db, { userId: 'user-1', phone: '+8613900000100', tenantId: 'tenant-1', status: 'ready', gatewaySecret: 'tenant-secret' });
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(sha256Hex('session-token'), 'user-1', 1, 1, Date.now() + 60_000);
  const runtime = await startTestApp({ db, dockerUrl: 'http://127.0.0.1:1', pushProvider: 'fake' });
  const fake = (runtime.app.push as unknown as { providers: Record<string, FakePushProvider> }).providers.fake;
  t.after(async () => {
    await runtime.close();
    db.close();
  });
  const register = (deviceId: string) => api(runtime.baseUrl, '/api/v1/devices/register', {
    method: 'POST', cookie: 'idb_session=session-token',
    body: { deviceId, installationId: `installation-${deviceId}`, platform: 'android', provider: 'fake', token: `provider-token-${deviceId}`, appVersion: '1.2.0', shellVersion: '1.2.0' },
  });
  const ingest = (eventId: string, category = 'work') => api(runtime.baseUrl, '/internal/v1/tenants/tenant-1/notifications', {
    method: 'POST', origin: null,
    headers: { authorization: 'Bearer tenant-secret', 'x-tenant-id': 'tenant-1' },
    body: { eventId, type: 'work.completed', category, title: 'Task completed', body: 'Open the result.', priority: 'normal' },
  });
  return { db, runtime, fake, register, ingest };
}

test('device registration encrypts tokens and tenant ingest dedupes each device', async (t) => {
  const { db, runtime, fake, register, ingest } = await setup(t);
  assert.equal((await api(runtime.baseUrl, '/api/v1/devices/register', { method: 'POST', body: {} })).status, 401);
  assert.equal((await register('device-1')).status, 200);
  assert.equal((await register('device-2')).status, 200);
  const stored = db.prepare('SELECT token_enc FROM user_devices WHERE device_id = ?').get('device-1') as { token_enc: string };
  assert.notEqual(stored.token_enc, 'provider-token-device-1');
  assert.equal(decryptSecret(MASTER_KEY, stored.token_enc), 'provider-token-device-1');

  const first = await ingest('event-1');
  const duplicate = await ingest('event-1');
  assert.equal(first.status, 202);
  assert.equal((first.json as { devices: number }).devices, 2);
  assert.equal((duplicate.json as { duplicate: boolean }).duplicate, true);
  assert.equal(fake.messages.length, 2);
  assert.equal(fake.messages[0].event.eventId, 'event-1');
  assert.deepEqual(Object.keys(fake.messages[0].event).sort(), ['body', 'category', 'eventId', 'priority', 'title', 'type']);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM push_deliveries WHERE state = 'sent'").get().count, 2);
});

test('provider retry, invalid-token revocation, preference filtering and unregister are durable', async (t) => {
  const { db, runtime, fake, register, ingest } = await setup(t);
  await register('device-1');
  fake.failure = new PushProviderError('FCM_UNAVAILABLE', true);
  await ingest('event-retry');
  assert.equal(db.prepare("SELECT state, attempts FROM push_deliveries WHERE event_id = 'event-retry'").get().state, 'retry');
  fake.failure = null;
  db.prepare("UPDATE push_deliveries SET next_attempt_at = 0 WHERE event_id = 'event-retry'").run();
  await runtime.app.push.deliverDue('event-retry');
  assert.equal(db.prepare("SELECT state FROM push_deliveries WHERE event_id = 'event-retry'").get().state, 'sent');

  fake.failure = new PushProviderError('FCM_UNREGISTERED', false, true);
  await ingest('event-invalid');
  assert.equal(db.prepare("SELECT enabled FROM user_devices WHERE device_id = 'device-1'").get().enabled, 0);
  await register('device-1');
  const preferences = await api(runtime.baseUrl, '/api/v1/notification-preferences', {
    method: 'PUT', cookie: 'idb_session=session-token', body: { preferences: { action: false } },
  });
  assert.equal((preferences.json as { preferences: { action: boolean } }).preferences.action, false);
  fake.failure = null;
  const filtered = await ingest('event-action', 'action');
  assert.equal((filtered.json as { devices: number }).devices, 0);
  await ingest('event-work');
  assert.equal(fake.messages.length, 2);

  assert.equal((await api(runtime.baseUrl, '/api/v1/devices/unregister', {
    method: 'POST', cookie: 'idb_session=session-token', body: { deviceId: 'device-1' },
  })).status, 200);
  await ingest('event-after-logout');
  assert.equal(db.prepare("SELECT enabled FROM user_devices WHERE device_id = 'device-1'").get().enabled, 0);
  assert.equal(fake.messages.length, 2);
});

test('tenant ingest requires its own credential and rejects malformed events', async (t) => {
  const { runtime, register, ingest } = await setup(t);
  await register('device-1');
  const rejected = await api(runtime.baseUrl, '/internal/v1/tenants/other-tenant/notifications', {
    method: 'POST', origin: null, headers: { authorization: 'Bearer tenant-secret', 'x-tenant-id': 'tenant-1' }, body: {},
  });
  assert.equal(rejected.status, 401);
  const malformed = await api(runtime.baseUrl, '/internal/v1/tenants/tenant-1/notifications', {
    method: 'POST', origin: null, headers: { authorization: 'Bearer tenant-secret', 'x-tenant-id': 'tenant-1' },
    body: { eventId: 'event', type: 'work.completed', category: 'internal-debug', title: 'secret', body: 'secret', priority: 'normal' },
  });
  assert.equal(malformed.status, 400);
  assert.equal((await ingest('event-1')).status, 202);
});

test('FCM adapter exchanges a scoped service-account JWT and recognizes revoked tokens', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const provider = new FcmPushProvider(
    { projectId: 'test-project', clientEmail: 'push@example.test', privateKey },
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('oauth2')) return Response.json({ access_token: 'test-access-token', expires_in: 3600 });
      return Response.json({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }, { status: 404 });
    },
  );
  const event = { eventId: 'event-1', type: 'work.completed', category: 'work' as const, title: 'Done', body: 'Open', priority: 'normal' as const };
  await assert.rejects(provider.send({ token: 'revoked-token', event }), (error: unknown) => error instanceof PushProviderError && error.invalidToken && !error.retryable);
  assert.equal(calls.length, 2);
  const assertion = new URLSearchParams(String(calls[0].init?.body)).get('assertion')!;
  const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(claims.iss, 'push@example.test');
  assert.equal(calls[1].init?.headers.authorization, 'Bearer test-access-token');
  const message = JSON.parse(String(calls[1].init?.body)).message;
  assert.equal(message.data.eventId, 'event-1');
  assert.equal(message.android.notification.channel_id, 'work');
  assert.equal(message.android.notification.tag, 'event-1');
});
