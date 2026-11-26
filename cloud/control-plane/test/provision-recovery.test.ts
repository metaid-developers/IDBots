import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type Database from 'better-sqlite3';
import { FakeDocker } from './fake-docker/index.mjs';
import {
  api,
  freshDb,
  seedUserAndTenant,
  startAlertSink,
  startTestApp,
  waitFor,
  type TestApp,
} from './helpers.js';
import { DockerClient } from '../src/docker/client.js';
import { sha256Hex } from '../src/crypto.js';
import { TenantPoller } from '../src/services/poller.js';
import {
  isProvisioningInFlight,
  isRecoverableProvisionFailure,
  triggerRetryFailedProvisioning,
} from '../src/services/provisioning.js';

let db: Database.Database;
let fake: FakeDocker;
let client: DockerClient;
let sink: { url: string; messages: string[]; close: () => Promise<void> };
let app: TestApp;

before(async () => {
  db = freshDb();
  fake = new FakeDocker();
  await fake.listen(0);
  client = new DockerClient(fake.url());
  sink = await startAlertSink();
  app = await startTestApp({
    db,
    dockerUrl: fake.url(),
    alertWebhook: sink.url,
    fakeSmsNumbers: ['+8613900009002'],
  });
});

after(async () => {
  await app.close();
  await sink.close();
  await fake.close();
  db.close();
});

function createSession(userId: string): string {
  const token = `tok_${userId}_${Date.now()}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, 'test', '127.0.0.1')`,
  ).run(sha256Hex(token), userId, now, now, now + 86_400_000);
  return `idb_session=${token}`;
}

async function seedCreatedContainer(tenantId: string, secret = 'same-secret'): Promise<void> {
  await client.createVolume(`idb-${tenantId}-data`);
  await client.createContainer({
    name: `idb-${tenantId}`,
    image: 'fake-tenant:test',
    env: {
      IDBOTS_SERVER_MODE: '1',
      IDBOTS_TENANT_ID: tenantId,
      IDBOTS_GATEWAY_SECRET: secret,
      FAKE_TENANT_HEALTH_AFTER_MS: '0',
      FAKE_TENANT_PHASES: 'ready:0',
    },
  });
}

describe('failed provisioning retry and recovery', () => {
  test('isRecoverableProvisionFailure distinguishes transient provisioning errors from permanent failures', () => {
    assert.equal(
      isRecoverableProvisionFailure({
        status: 'failed',
        last_error: 'container create/start failed: docker request timed out',
      }),
      true,
    );
    assert.equal(
      isRecoverableProvisionFailure({
        status: 'failed',
        last_error: 'existing container adopt/start failed: ECONNRESET',
      }),
      true,
    );
    assert.equal(
      isRecoverableProvisionFailure({
        status: 'failed',
        last_error: 'container spec build failed: ciphertext too short',
      }),
      false,
    );
    assert.equal(
      isRecoverableProvisionFailure({
        status: 'failed',
        last_error: 'recovery rollback failed: bad image',
      }),
      false,
    );
    assert.equal(
      isRecoverableProvisionFailure({
        status: 'ready',
        last_error: 'container create/start failed: docker request timed out',
      }),
      false,
    );
  });

  test('GET /api/v1/me?retry=1 adopts an orphaned Created container and brings tenant to ready', async () => {
    seedUserAndTenant(db, {
      userId: 'u_prec1',
      phone: '+8613900009001',
      tenantId: 't_prec1',
      status: 'failed',
      gatewaySecret: 'secret-prec1',
    });
    db.prepare(
      "UPDATE tenants SET last_error = 'container create/start failed: docker request timed out' WHERE id = 't_prec1'",
    ).run();
    // Docker finished creating the container after the HTTP client timed out, leaving it unstarted.
    await seedCreatedContainer('t_prec1', 'secret-prec1');
    const cookie = createSession('u_prec1');

    const res = await api(app.baseUrl, '/api/v1/me?retry=1', { cookie });
    assert.equal(res.status, 200);
    assert.equal((res.json as { tenant: { status: string } }).tenant.status, 'provisioning');

    const poller = new TenantPoller(app.app, { tickFastMs: 50, tickSlowMs: 100 });
    poller.start();
    try {
      await waitFor(async () => {
        const row = db.prepare("SELECT status FROM tenants WHERE id = 't_prec1'").get() as {
          status: string;
        };
        return row.status === 'ready' ? true : null;
      }, 10_000);
    } finally {
      await poller.stop();
    }

    const audits = db
      .prepare("SELECT action, detail_json FROM audit_log WHERE target = 't_prec1' AND action = 'tenant.provision.retry'")
      .all() as Array<{ action: string; detail_json: string }>;
    assert.equal(audits.length, 1);
    assert.match(audits[0].detail_json, /"source":"retry_param"/);
  });

  test('POST /api/v1/auth/sms/verify recovers a failed tenant on re-login', async () => {
    seedUserAndTenant(db, {
      userId: 'u_prec2',
      phone: '+8613900009002',
      tenantId: 't_prec2',
      status: 'failed',
      gatewaySecret: 'secret-prec2',
    });
    db.prepare(
      "UPDATE tenants SET last_error = 'container create/start failed: docker request timed out' WHERE id = 't_prec2'",
    ).run();

    const sendRes = await api(app.baseUrl, '/api/v1/auth/sms/send', {
      method: 'POST',
      body: { phone: '+8613900009002', purpose: 'login' },
    });
    assert.equal(sendRes.status, 200);

    const verifyRes = await api(app.baseUrl, '/api/v1/auth/sms/verify', {
      method: 'POST',
      body: { phone: '+8613900009002', code: '246810' },
    });
    assert.equal(verifyRes.status, 200);
    assert.equal((verifyRes.json as { tenant: { status: string } }).tenant.status, 'provisioning');

    const poller = new TenantPoller(app.app, { tickFastMs: 50, tickSlowMs: 100 });
    poller.start();
    try {
      await waitFor(async () => {
        const row = db.prepare("SELECT status FROM tenants WHERE id = 't_prec2'").get() as {
          status: string;
        };
        return row.status === 'ready' ? true : null;
      }, 10_000);
    } finally {
      await poller.stop();
    }
  });

  test('TenantPoller recovers an orphaned failed provisioning row once automatically and ignores non-recoverable failures', async () => {
    seedUserAndTenant(db, {
      userId: 'u_prec3',
      phone: '+8613900009003',
      tenantId: 't_prec3',
      status: 'failed',
      gatewaySecret: 'secret-prec3',
    });
    db.prepare(
      "UPDATE tenants SET last_error = 'container create/start failed: docker request timed out', updated_at = ? WHERE id = 't_prec3'",
    ).run(Date.now() - 60_000);
    await seedCreatedContainer('t_prec3', 'secret-prec3');

    seedUserAndTenant(db, {
      userId: 'u_prec4',
      phone: '+8613900009004',
      tenantId: 't_prec4',
      status: 'failed',
      gatewaySecret: 'secret-prec4',
    });
    db.prepare(
      "UPDATE tenants SET last_error = 'container spec build failed: bad cipher', updated_at = ? WHERE id = 't_prec4'",
    ).run(Date.now() - 60_000);

    const poller = new TenantPoller(app.app, {
      tickFastMs: 50,
      tickSlowMs: 100,
      failedProvisionRetryMs: 1_000,
    });
    poller.start();
    try {
      await waitFor(async () => {
        const row = db.prepare("SELECT status FROM tenants WHERE id = 't_prec3'").get() as {
          status: string;
        };
        return row.status === 'ready' ? true : null;
      }, 10_000);
    } finally {
      await poller.stop();
    }

    const permRow = db.prepare("SELECT status FROM tenants WHERE id = 't_prec4'").get() as {
      status: string;
    };
    assert.equal(permRow.status, 'failed');
  });

  test('me_auto retries are capped at 2 attempts so passive polling cannot loop indefinitely', async () => {
    seedUserAndTenant(db, {
      userId: 'u_prec5',
      phone: '+8613900009005',
      tenantId: 't_prec5',
      status: 'failed',
      gatewaySecret: 'secret-prec5',
    });
    const staleAt = Date.now() - 60_000;
    db.prepare(
      "UPDATE tenants SET last_error = 'volume create failed: boom', updated_at = ? WHERE id = 't_prec5'",
    ).run(staleAt);

    const failingDocker = {
      createVolume: async () => {
        throw new Error('still down');
      },
    } as unknown as DockerClient;
    const appNoStart = { ...app.app, docker: failingDocker };

    const r1 = triggerRetryFailedProvisioning(appNoStart, 't_prec5', {
      source: 'me_auto',
      cooldownMs: 0,
      now: Date.now(),
    });
    assert.equal(r1, true);
    await waitFor(async () => (!isProvisioningInFlight('t_prec5') ? true : null));
    db.prepare('UPDATE tenants SET updated_at = ? WHERE id = ?').run(staleAt, 't_prec5');

    const r2 = triggerRetryFailedProvisioning(appNoStart, 't_prec5', {
      source: 'me_auto',
      cooldownMs: 0,
      now: Date.now(),
    });
    assert.equal(r2, true);
    await waitFor(async () => (!isProvisioningInFlight('t_prec5') ? true : null));
    db.prepare('UPDATE tenants SET updated_at = ? WHERE id = ?').run(staleAt, 't_prec5');

    const r3 = triggerRetryFailedProvisioning(appNoStart, 't_prec5', {
      source: 'me_auto',
      cooldownMs: 0,
      now: Date.now(),
    });
    assert.equal(r3, false, 'third passive me_auto attempt is capped');
  });
});
