import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type Database from 'better-sqlite3';
import { FakeDocker } from './fake-docker/index.mjs';
import { freshDb, seedUserAndTenant, startTestApp, waitFor, type TestApp } from './helpers.js';
import { DockerClient } from '../src/docker/client.js';
import { registerRelease } from '../src/services/releases.js';
import { RolloutManager } from '../src/rollout/manager.js';
import { SqliteRolloutStore } from '../src/rollout/sqliteStore.js';

const OLD_IMAGE = 'tenant:rollout-old';
const BAD_IMAGE = 'tenant:rollout-bad';
let db: Database.Database;
let fake: FakeDocker;
let client: DockerClient;
let app: TestApp;
let sequence = 0;

before(async () => {
  db = freshDb();
  fake = new FakeDocker({
    imageEnv: { [BAD_IMAGE]: { FAKE_TENANT_HEALTH_AFTER_MS: '60000' } },
  });
  await fake.listen(0);
  client = new DockerClient(fake.url());
  app = await startTestApp({ db, dockerUrl: fake.url(), tenantImage: OLD_IMAGE });
  await seedImage(OLD_IMAGE);
});

after(async () => {
  await app.close();
  await fake.close();
  db.close();
});

async function seedImage(image: string): Promise<void> {
  const res = await fetch(`${fake.url()}/fake/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ref: image,
      labels: { 'org.idbots.version': '1.2.0', 'org.idbots.rollback-safe-to': '1.0.0' },
    }),
  });
  assert.equal(res.status, 201);
}

async function seedTenant(kind: 'customer' | 'internal' | 'synthetic' | 'demo' = 'customer'): Promise<string> {
  sequence += 1;
  const id = `t_ro${sequence}`;
  seedUserAndTenant(db, {
    userId: `u_ro${sequence}`,
    phone: `+861390001${String(sequence).padStart(4, '0')}`,
    tenantId: id,
    status: 'ready',
    image: OLD_IMAGE,
    appVersion: '1.0.0',
  });
  db.prepare('UPDATE tenants SET kind = ?, cohort = ? WHERE id = ?')
    .run(kind, kind === 'customer' ? 'stable' : 'canary', id);
  const created = await client.createContainer({
    name: `idb-${id}`,
    image: OLD_IMAGE,
    env: {
      IDBOTS_SERVER_MODE: '1',
      IDBOTS_TENANT_ID: id,
      IDBOTS_GATEWAY_SECRET: 'test-secret',
      FAKE_TENANT_HEALTH_AFTER_MS: '0',
      FAKE_TENANT_PHASES: 'ready:0',
      FAKE_TENANT_APP_VERSION: '1.0.0',
    },
  });
  await client.startContainer(created.Id);
  return id;
}

function register(image: string): string {
  sequence += 1;
  return registerRelease(db, {
    schemaVersion: 1,
    sourceSha: 'a'.repeat(40),
    appVersion: '1.2.0',
    contractVersion: '1.0.0',
    rollbackSafeTo: '1.0.0',
    databaseSchemaVersion: 9,
    tenant: { image, digest: `sha256:${sequence.toString(16).padStart(64, '0')}` },
    controlPlane: { image: `cp:${sequence}`, digest: `sha256:${(sequence + 1).toString(16).padStart(64, '0')}` },
    createdAt: new Date().toISOString(),
    createdBy: 'test',
  }, 'test').release.id;
}

function manager(): RolloutManager {
  return new RolloutManager(app.app, new SqliteRolloutStore(db), {
    tickMs: 40,
    leaseMs: 5000,
    readyTimeoutMs: 1500,
    readyPollMs: 40,
  });
}

describe('persistent staged rollouts', () => {
  test('runs canary and remaining waves to completion with durable per-tenant outcomes', async () => {
    const image = 'tenant:rollout-good';
    await seedImage(image);
    const ids = [await seedTenant('synthetic'), await seedTenant('internal')];
    for (let i = 0; i < 4; i += 1) ids.push(await seedTenant());
    const releaseId = register(image);
    const run = manager();
    const created = await run.create({ releaseId, operator: 'test', tenantIds: ids, globalConcurrency: 2, soakMs: 0 });
    assert.equal(created.items.length, 6);
    assert.ok(created.waves.length >= 2);
    assert.equal(created.items.find((item) => item.waveIndex === 0)?.tenantId, 't_ro1');
    await run.start();
    try {
      await run.startJob(created.job.id);
      await waitFor(async () => ((await run.requireJob(created.job.id)).job.status === 'completed' ? true : null), 15000);
      const finished = await run.requireJob(created.job.id);
      assert.ok(finished.items.every((item) => item.status === 'succeeded'));
      assert.ok(finished.items.every((item) => item.attempts === 1));
      assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM tenants WHERE image = ?").get(image), { n: 6 });
    } finally {
      await run.stop();
    }
  });

  test('pause blocks new scheduling; resume and persisted job state continue', async () => {
    const image = 'tenant:rollout-pause';
    await seedImage(image);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push(await seedTenant());
    const releaseId = register(image);
    const run = manager();
    const created = await run.create({ releaseId, operator: 'test', tenantIds: ids, soakMs: 0 });
    await run.pause(created.job.id, 'operator test pause');
    assert.equal((await run.requireJob(created.job.id)).job.status, 'paused');
    assert.ok((await run.requireJob(created.job.id)).items.every((item) => item.status === 'pending'));
    const recovered = manager();
    assert.equal((await recovered.requireJob(created.job.id)).items.length, 3);
    await recovered.start();
    try {
      await recovered.resume(created.job.id);
      await waitFor(async () => ((await recovered.requireJob(created.job.id)).job.status === 'completed' ? true : null), 15000);
    } finally {
      await recovered.stop();
    }
  });

  test('a failed canary rolls back and pauses the job instead of expanding', async () => {
    const image = BAD_IMAGE;
    await seedImage(image);
    const tenantId = await seedTenant('synthetic');
    const releaseId = register(image);
    const run = manager();
    const created = await run.create({ releaseId, operator: 'test', tenantIds: [tenantId], soakMs: 0 });
    await run.start();
    try {
      await run.startJob(created.job.id);
      await waitFor(async () => ((await run.requireJob(created.job.id)).job.status === 'paused' ? true : null), 15000);
      const paused = await run.requireJob(created.job.id);
      assert.equal(paused.items[0].status, 'rolled-back');
      assert.match(paused.job.stopReason ?? '', /safety gate/);
      assert.equal(await run.retryFailed(created.job.id), 1);
      assert.equal((await run.requireJob(created.job.id)).items[0].status, 'pending');
    } finally {
      await run.stop();
    }
  });

  test('startup recovery requeues only expired leases, not healthy workers', async () => {
    const image = 'tenant:rollout-lease';
    await seedImage(image);
    const tenantId = await seedTenant();
    const releaseId = register(image);
    const run = manager();
    const store = new SqliteRolloutStore(db);
    const created = await run.create({ releaseId, operator: 'test', tenantIds: [tenantId], soakMs: 0 });
    await store.setJobStatus(created.job.id, 'running');
    const claimed = await store.claimItems(created.job.id, 'healthy-worker', 1, 30_000, 1000);
    assert.equal(claimed.length, 1);
    assert.equal(await store.requeueInFlight(2000), 0);
    assert.equal((await store.getJob(created.job.id))?.items[0].leaseOwner, 'healthy-worker');
    assert.equal(await store.requeueInFlight(31_000), 1);
    assert.equal((await store.getJob(created.job.id))?.items[0].status, 'pending');
  });

  test('missing target image fails preflight before a tenant is touched', async () => {
    const image = 'tenant:rollout-not-pulled';
    const tenantId = await seedTenant();
    const releaseId = register(image);
    const run = manager();
    const created = await run.create({ releaseId, operator: 'test', tenantIds: [tenantId], soakMs: 0 });
    await run.start();
    try {
      await run.startJob(created.job.id);
      await waitFor(async () => ((await run.requireJob(created.job.id)).job.status === 'paused' ? true : null), 5000);
      assert.match((await run.requireJob(created.job.id)).job.stopReason ?? '', /preflight/);
      assert.equal((await run.requireJob(created.job.id)).items[0].attempts, 0);
    } finally {
      await run.stop();
    }
  });
});
