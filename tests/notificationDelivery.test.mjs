import test from 'node:test';
import assert from 'node:assert/strict';

const { createNativeSqliteDatabase } = await import('../dist-electron/main/nativeSqliteDatabase.js');
const { NotificationStore } = await import('../dist-electron/main/notificationStore.js');
const { runNotificationDeliveryOnce } = await import('../dist-electron/main/services/notificationDeliveryService.js');

function setup(t) {
  const db = createNativeSqliteDatabase(':memory:');
  assert.ok(db);
  const store = new NotificationStore(db, () => {});
  t.after(() => db.close());
  store.record({
    eventId: 'cowork:session-1:completed:1', type: 'work.completed', category: 'work', createdAt: 1,
    metabotId: null, sessionId: 'session-1', taskId: null, runId: null,
    title: 'Task completed', body: 'Open the result.', priority: 'normal',
    target: { kind: 'session', sessionId: 'session-1' },
  });
  return store;
}

const config = { controlPlaneUrl: 'https://cp.example.com', tenantId: 'tenant-1', gatewaySecret: 'test-secret' };

test('tenant delivery sends the stable event with tenant authentication', async (t) => {
  const store = setup(t);
  const calls = [];
  const result = await runNotificationDeliveryOnce({
    store, config, now: () => 1,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 202 });
    },
  });
  assert.deepEqual(result, { accepted: ['cowork:session-1:completed:1'], failed: [] });
  assert.equal(calls[0].url, 'https://cp.example.com/internal/v1/tenants/tenant-1/notifications');
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-secret');
  assert.equal(calls[0].init.headers['x-tenant-id'], 'tenant-1');
  assert.equal(calls[0].body.eventId, 'cowork:session-1:completed:1');
  assert.deepEqual(store.listPendingOutbox(), []);
});

test('a failed request stays pending and retries with its persisted attempt count', async (t) => {
  const store = setup(t);
  let now = 1;
  const failed = await runNotificationDeliveryOnce({
    store, config, now: () => now,
    fetchImpl: async () => new Response(null, { status: 503 }),
  });
  assert.deepEqual(failed.accepted, []);
  assert.deepEqual(failed.failed, ['cowork:session-1:completed:1']);
  assert.deepEqual(store.listPendingOutbox(), [{ eventId: 'cowork:session-1:completed:1', attemptCount: 1, nextAttemptAt: 15001 }]);
  now = 30000;
  await runNotificationDeliveryOnce({ store, config, now: () => now, fetchImpl: async () => new Response(null, { status: 503 }) });
  assert.deepEqual(store.listPendingOutbox(), [{ eventId: 'cowork:session-1:completed:1', attemptCount: 2, nextAttemptAt: 60000 }]);
});

test('read notifications are not delivered and missing configuration is a safe no-op', async (t) => {
  const store = setup(t);
  store.markRead(['cowork:session-1:completed:1']);
  let called = false;
  const result = await runNotificationDeliveryOnce({
    store, config, now: () => 1,
    fetchImpl: async () => { called = true; return new Response(null, { status: 202 }); },
  });
  assert.equal(called, false);
  assert.deepEqual(result, { accepted: [], failed: [] });
  assert.match((await runNotificationDeliveryOnce({ store, config: null })).skipped, /credentials missing/);
});
