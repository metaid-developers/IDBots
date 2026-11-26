import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type Database from 'better-sqlite3';
import { FakeDocker } from './fake-docker/index.mjs';
import { freshDb, seedUserAndTenant, startTestApp, waitFor, type TestApp } from './helpers.js';
import { registerRelease } from '../src/services/releases.js';
import { RolloutManager } from '../src/rollout/manager.js';
import { SqliteRolloutStore } from '../src/rollout/sqliteStore.js';

const TENANT_COUNT = 1000;
let db: Database.Database;
let fake: FakeDocker;
let app: TestApp;

before(async () => {
  db = freshDb();
  fake = new FakeDocker();
  await fake.listen(0);
  app = await startTestApp({ db, dockerUrl: fake.url() });
  db.transaction(() => {
    for (let host = 0; host < 20; host += 1) {
      db.prepare("INSERT INTO hosts (id, docker_url, capacity, status, environment) VALUES (?, 'agent://scale', 50, 'active', 'production')")
        .run(`h_scale_${host}`);
    }
    for (let index = 0; index < TENANT_COUNT; index += 1) {
      const id = `t_scale_${index}`;
      seedUserAndTenant(db, {
        userId: `u_scale_${index}`,
        phone: `+8613900${String(index).padStart(7, '0')}`,
        tenantId: id,
        status: 'ready',
        image: 'tenant:scale-old',
      });
      db.prepare("UPDATE tenants SET host_id = ?, kind = 'synthetic', cohort = 'stable' WHERE id = ?")
        .run(`h_scale_${index % 20}`, id);
    }
  })();
});

after(async () => {
  await app.close();
  await fake.close();
  db.close();
});

describe('1,000-tenant commercial rollout drill', () => {
  test('honors concurrency, persists waves, and resumes after a scheduler restart', async () => {
    const releaseId = registerRelease(db, {
      schemaVersion: 1,
      sourceSha: 'b'.repeat(40),
      appVersion: '2.0.0',
      contractVersion: '1.0.0',
      rollbackSafeTo: '1.0.0',
      databaseSchemaVersion: 11,
      tenant: { image: 'tenant:scale-new', digest: `sha256:${'b'.repeat(64)}` },
      controlPlane: { image: 'cp:scale-new', digest: `sha256:${'c'.repeat(64)}` },
      createdAt: new Date().toISOString(),
      createdBy: 'scale-test',
    }, 'scale-test').release.id;
    const store = new SqliteRolloutStore(db);
    let completed = 0;
    let active = 0;
    let maxActive = 0;
    const hostActive = new Map<string, number>();
    const maxHostActive = new Map<string, number>();
    const preflights = new Set<string>();
    const options = {
      tickMs: 10,
      leaseMs: 5000,
      globalConcurrency: 50,
      perHostConcurrency: 2,
      preflight: async (hostId: string): Promise<void> => {
        preflights.add(hostId);
      },
      executor: async (item: import('../src/rollout/types.js').RolloutItem) => {
        active += 1;
        completed += 1;
        maxActive = Math.max(maxActive, active);
        const hostCount = (hostActive.get(item.hostId) ?? 0) + 1;
        hostActive.set(item.hostId, hostCount);
        maxHostActive.set(item.hostId, Math.max(maxHostActive.get(item.hostId) ?? 0, hostCount));
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        hostActive.set(item.hostId, (hostActive.get(item.hostId) ?? 1) - 1);
        return { tenantId: item.tenantId, outcome: 'upgraded' as const, detail: 'ready' };
      },
    };
    const first = new RolloutManager(app.app, store, options);
    const created = await first.create({
      releaseId,
      operator: 'scale-test',
      globalConcurrency: 50,
      perHostConcurrency: 2,
      soakMs: 0,
    });
    assert.equal(created.items.length, TENANT_COUNT);
    assert.equal(created.waves.length, 5);
    assert.equal(created.job.perHostConcurrency, 2);
    assert.equal(created.job.globalConcurrency, 50);
    await first.start();
    await first.startJob(created.job.id);
    await waitFor(async () => (completed >= 250 ? true : null), 15000);
    await first.stop();
    assert.ok(completed < TENANT_COUNT);

    const resumed = new RolloutManager(app.app, store, options);
    await resumed.start();
    try {
      await waitFor(async () => ((await resumed.requireJob(created.job.id)).job.status === 'completed' ? true : null), 60000, 50);
    } finally {
      await resumed.stop();
    }
    const view = await resumed.requireJob(created.job.id);
    assert.equal(view.items.filter((item) => item.status === 'succeeded').length, TENANT_COUNT);
    assert.equal(completed, TENANT_COUNT);
    assert.ok(view.items.every((item) => item.attempts === 1));
    assert.ok(maxActive <= 50, `global concurrency reached ${maxActive}`);
    assert.ok(
      [...maxHostActive.values()].every((value) => value <= 2),
      `per-host maxima: ${JSON.stringify(Object.fromEntries(maxHostActive))}`,
    );
    assert.equal(preflights.size, 20);
    assert.ok((await store.listPreflightHosts(created.job.id, 0)).every((host) => host.status === 'ready'));
  });
});
