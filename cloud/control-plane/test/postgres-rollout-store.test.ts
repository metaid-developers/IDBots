import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { newDb } from 'pg-mem';
import type { Pool } from 'pg';
import { PostgresRolloutStore } from '../src/rollout/postgresStore.js';

let store: PostgresRolloutStore;

before(async () => {
  const memory = newDb();
  const pool = new (memory.adapters.createPg().Pool)() as unknown as Pool;
  store = new PostgresRolloutStore(pool);
  await store.init();
});

after(async () => {
  await store.close();
});

describe('PostgreSQL rollout store', () => {
  test('persists jobs and coordinates worker claims without duplicates', async () => {
    const created = await store.createJob({
      id: 'ro_pg_test',
      releaseId: 'rel_pg_test',
      mode: 'upgrade',
      globalConcurrency: 2,
      perHostConcurrency: 1,
      failureThresholdPercent: 2,
      failureThresholdCount: 3,
      consecutiveFailureLimit: 2,
      operator: 'test',
      waves: [{ index: 0, label: 'canary', soakMs: 0 }],
      items: [
        { tenantId: 't_pg_1', hostId: 'h_a', waveIndex: 0 },
        { tenantId: 't_pg_2', hostId: 'h_a', waveIndex: 0 },
        { tenantId: 't_pg_3', hostId: 'h_b', waveIndex: 0 },
      ],
    });
    assert.equal(created.items.length, 3);
    await store.setJobStatus(created.job.id, 'running');
    const first = await store.claimItems(created.job.id, 'worker-a', 2, 30_000, 1000);
    assert.deepEqual(first.map((item) => item.tenantId), ['t_pg_1', 't_pg_3']);
    assert.equal((await store.claimItems(created.job.id, 'worker-b', 2, 30_000, 1001)).length, 0);
    assert.equal(await store.hasRunningItem('t_pg_1'), true);
    await store.completeItem(created.job.id, 't_pg_1', 'worker-a', 'succeeded', 'upgraded', null, 2000);
    const second = await store.claimItems(created.job.id, 'worker-b', 1, 30_000, 2001);
    assert.deepEqual(second.map((item) => item.tenantId), ['t_pg_2']);
    await store.completeItem(created.job.id, 't_pg_2', 'worker-b', 'failed', 'failed', 'injected', 3000);
    await store.completeItem(created.job.id, 't_pg_3', 'worker-a', 'rolled-back', 'rolled-back', 'injected', 3001);
    assert.equal(await store.retryFailed(created.job.id), 2);
    assert.equal(await store.requeueInFlight(), 0);
    const view = await store.getJob(created.job.id);
    assert.ok(view);
    assert.equal(view.items.find((item) => item.tenantId === 't_pg_1')?.status, 'succeeded');
    assert.equal(view.items.filter((item) => item.status === 'pending').length, 2);
    assert.equal((await store.listPreflightHosts(created.job.id, 0)).length, 2);
  });
});
