import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type Database from 'better-sqlite3';
import { FakeDocker } from './fake-docker/index.mjs';
import {
  freshDb,
  seedUserAndTenant,
  startAlertSink,
  startTestApp,
  waitFor,
  type TestApp,
} from './helpers.js';
import { DockerClient } from '../src/docker/client.js';
import { upgradeTenants } from '../src/services/upgrade.js';

let db: Database.Database;
let fake: FakeDocker;
let client: DockerClient;
let sink: { url: string; messages: string[]; close: () => Promise<void> };
let app: TestApp;

const IMAGE_1_0 = 'tenant:1.0.0';
const IMAGE_1_1 = 'tenant:1.1.0';
const IMAGE_1_1_BAD = 'tenant:1.1.0-bad';
const IMAGE_2_0 = 'tenant:2.0.0';
const IMAGE_STRICT = 'tenant:1.1.0-strict';

before(async () => {
  db = freshDb();
  // Versioned images report their own app version via per-image env; the
  // broken variants never become healthy.
  fake = new FakeDocker({
    imageEnv: {
      [IMAGE_1_0]: { FAKE_TENANT_APP_VERSION: '1.0.0' },
      [IMAGE_STRICT]: { FAKE_TENANT_APP_VERSION: '1.1.0' },
      [IMAGE_1_1]: { FAKE_TENANT_APP_VERSION: '1.1.0' },
      [IMAGE_1_1_BAD]: { FAKE_TENANT_APP_VERSION: '1.1.0', FAKE_TENANT_HEALTH_AFTER_MS: '60000' },
      [IMAGE_2_0]: { FAKE_TENANT_APP_VERSION: '2.0.0', FAKE_TENANT_HEALTH_AFTER_MS: '60000' },
    },
  });
  await fake.listen(0);
  client = new DockerClient(fake.url());
  sink = await startAlertSink();
  app = await startTestApp({ db, dockerUrl: fake.url(), alertWebhook: sink.url, tenantImage: IMAGE_1_0 });

  const seed = async (ref: string, labels: Record<string, string>) => {
    const res = await fetch(`${fake.url()}/fake/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref, labels }),
    });
    assert.equal(res.status, 201);
  };
  await seed(IMAGE_1_0, { 'org.idbots.version': '1.0.0', 'org.idbots.rollback-safe-to': '' });
  await seed(IMAGE_1_1, { 'org.idbots.version': '1.1.0', 'org.idbots.rollback-safe-to': '1.0.0' });
  await seed(IMAGE_1_1_BAD, { 'org.idbots.version': '1.1.0', 'org.idbots.rollback-safe-to': '1.0.0' });
  await seed(IMAGE_2_0, { 'org.idbots.version': '2.0.0', 'org.idbots.rollback-safe-to': '' });
  await seed(IMAGE_STRICT, { 'org.idbots.version': '1.1.0', 'org.idbots.rollback-safe-to': '1.1.0' });
});

after(async () => {
  await app.close();
  await sink.close();
  await fake.close();
  db.close();
});

async function startTenantContainer(tenantId: string, image: string, appVersion: string): Promise<void> {
  const created = await client.createContainer({
    name: `idb-${tenantId}`,
    image,
    env: {
      IDBOTS_SERVER_MODE: '1',
      IDBOTS_TENANT_ID: tenantId,
      IDBOTS_GATEWAY_SECRET: 'test-secret',
      FAKE_TENANT_HEALTH_AFTER_MS: '0',
      FAKE_TENANT_PHASES: 'ready:0',
      FAKE_TENANT_APP_VERSION: appVersion,
    },
  });
  await client.startContainer(created.Id);
}

function tenantRow(id: string): {
  status: string;
  image: string;
  previous_image: string | null;
  app_version: string | null;
  last_error: string | null;
} {
  return db.prepare('SELECT status, image, previous_image, app_version, last_error FROM tenants WHERE id = ?').get(id) as never;
}

function audits(id: string, action: string): Array<{ actor: string }> {
  return db
    .prepare('SELECT actor FROM audit_log WHERE target = ? AND action = ?')
    .all(id, action) as Array<{ actor: string }>;
}

describe('tenant upgrade (REQ-B-12)', () => {
  test('happy path: 1.0.0 -> 1.1.0, ready again, image columns and audit rows', async () => {
    seedUserAndTenant(db, { userId: 'u_up1', phone: '+8613900005001', tenantId: 't_up1', status: 'ready', image: IMAGE_1_0, appVersion: '1.0.0' });
    await startTenantContainer('t_up1', IMAGE_1_0, '1.0.0');

    const results = await upgradeTenants(app.app, ['t_up1'], IMAGE_1_1, {
      operator: 'tester',
      readyTimeoutMs: 5000,
      readyPollMs: 100,
    });
    assert.deepEqual(results.map((r) => r.outcome), ['upgraded']);

    const row = tenantRow('t_up1');
    assert.equal(row.status, 'ready');
    assert.equal(row.image, IMAGE_1_1);
    assert.equal(row.previous_image, IMAGE_1_0);
    assert.equal(row.app_version, '1.1.0');
    assert.deepEqual(audits('t_up1', 'tenant.upgrade.start').map((a) => a.actor), ['admin:tester']);
    assert.equal(audits('t_up1', 'tenant.upgrade.done').length, 1);
  });

  test('an explicit canary already on the target image is skipped, not recreated', async () => {
    seedUserAndTenant(db, { userId: 'u_skip1', phone: '+8613900005091', tenantId: 't_skip1', status: 'ready', image: IMAGE_1_1, appVersion: '1.1.0' });
    await startTenantContainer('t_skip1', IMAGE_1_1, '1.1.0');
    const before = (await client.listContainers({ namePrefix: 'idb-t_skip1' }))[0].Id;

    const results = await upgradeTenants(app.app, ['t_skip1'], IMAGE_1_1, {
      operator: 'tester',
      readyTimeoutMs: 1000,
      readyPollMs: 100,
    });
    assert.deepEqual(results.map((r) => r.outcome), ['skipped']);
    const after = (await client.listContainers({ namePrefix: 'idb-t_skip1' }))[0].Id;
    assert.equal(after, before);
    assert.equal(audits('t_skip1', 'tenant.upgrade.skipped').length, 1);
    assert.equal(audits('t_skip1', 'tenant.upgrade.start').length, 0);
  });

  test('never-ready new image rolls back automatically to the previous image', async () => {
    seedUserAndTenant(db, { userId: 'u_up2', phone: '+8613900005002', tenantId: 't_up2', status: 'ready', image: IMAGE_1_0, appVersion: '1.0.0' });
    await startTenantContainer('t_up2', IMAGE_1_0, '1.0.0');

    const results = await upgradeTenants(app.app, ['t_up2'], IMAGE_1_1_BAD, {
      operator: 'tester',
      readyTimeoutMs: 1200,
      readyPollMs: 100,
    });
    assert.deepEqual(results.map((r) => r.outcome), ['rolled-back']);

    const row = tenantRow('t_up2');
    assert.equal(row.status, 'ready');
    assert.equal(row.image, IMAGE_1_0, 'rolled back to the previous image');
    assert.equal(row.app_version, '1.0.0');
    assert.equal(audits('t_up2', 'tenant.upgrade.rollback.start').length, 1);
    assert.equal(audits('t_up2', 'tenant.upgrade.rollback.done').length, 1);
  });

  test('rollback-safe-to empty: failed with an alert', async () => {
    seedUserAndTenant(db, { userId: 'u_up3', phone: '+8613900005003', tenantId: 't_up3', status: 'ready', image: IMAGE_1_0, appVersion: '1.0.0' });
    await startTenantContainer('t_up3', IMAGE_1_0, '1.0.0');

    const results = await upgradeTenants(app.app, ['t_up3'], IMAGE_2_0, {
      operator: 'tester',
      readyTimeoutMs: 1200,
      readyPollMs: 100,
    });
    assert.deepEqual(results.map((r) => r.outcome), ['failed']);

    const row = tenantRow('t_up3');
    assert.equal(row.status, 'failed');
    assert.match(row.last_error ?? '', /rollback not allowed/);
    assert.equal(audits('t_up3', 'tenant.upgrade.failed').length, 1);
    await waitFor(async () => (sink.messages.some((m) => m.includes('t_up3')) ? true : null));
  });

  test('downgrade below rollback-safe-to is refused, container untouched', async () => {
    seedUserAndTenant(db, { userId: 'u_up4', phone: '+8613900005004', tenantId: 't_up4', status: 'ready', image: IMAGE_STRICT, appVersion: '1.1.0' });
    await startTenantContainer('t_up4', IMAGE_STRICT, '1.1.0');
    const before = await client.listContainers({ namePrefix: 'idb-t_up4' });
    assert.equal(before.length, 1);

    const results = await upgradeTenants(app.app, ['t_up4'], IMAGE_1_0, {
      operator: 'tester',
      readyTimeoutMs: 2000,
      readyPollMs: 100,
    });
    assert.deepEqual(results.map((r) => r.outcome), ['refused']);

    const row = tenantRow('t_up4');
    assert.equal(row.status, 'ready');
    assert.equal(row.image, IMAGE_STRICT, 'image unchanged');
    const after = await client.listContainers({ namePrefix: 'idb-t_up4' });
    assert.equal(after[0].Id, before[0].Id, 'same container, never recreated');
    assert.equal(audits('t_up4', 'tenant.upgrade.refused').length, 1);
    assert.equal(audits('t_up4', 'tenant.upgrade.start').length, 0);
  });

  test('batch=2 upgrades three tenants, all ready', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = `t_bat${i}`;
      ids.push(id);
      seedUserAndTenant(db, { userId: `u_bat${i}`, phone: `+86139000051${String(i).padStart(2, '0')}`, tenantId: id, status: 'ready', image: IMAGE_1_0, appVersion: '1.0.0' });
      await startTenantContainer(id, IMAGE_1_0, '1.0.0');
    }
    const results = await upgradeTenants(app.app, ids, IMAGE_1_1, {
      operator: 'tester',
      batch: 2,
      readyTimeoutMs: 8000,
      readyPollMs: 100,
    });
    assert.deepEqual(
      results.map((r) => r.outcome),
      ['upgraded', 'upgraded', 'upgraded'],
    );
    for (const id of ids) {
      assert.equal(tenantRow(id).image, IMAGE_1_1);
    }
  });
});
