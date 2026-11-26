import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type Database from 'better-sqlite3';
import { FakeDocker } from './fake-docker/index.mjs';
import { api, freshDb, seedUserAndTenant, startTestApp, type TestApp } from './helpers.js';
import { createAdminUser, totp, type AdminRole } from '../src/admin/auth.js';
import { registerRelease } from '../src/services/releases.js';

let db: Database.Database;
let fake: FakeDocker;
let app: TestApp;

before(async () => {
  db = freshDb();
  fake = new FakeDocker();
  await fake.listen(0);
  app = await startTestApp({ db, dockerUrl: fake.url() });
});

after(async () => {
  await app.close();
  await fake.close();
  db.close();
});

function administrator(username: string, role: AdminRole) {
  return createAdminUser(db, app.config.masterKey, { username, role }, 'test-bootstrap');
}

async function login(account: ReturnType<typeof administrator>): Promise<string> {
  const response = await api(app.baseUrl, '/api/v1/admin/session', {
    method: 'POST',
    body: { username: account.username, token: account.token, mfaCode: totp(account.mfaSecret) },
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return String((response.json as { sessionToken: string }).sessionToken);
}

function auth(token: string): { headers: Record<string, string> } {
  return { headers: { Authorization: `Bearer ${token}` } };
}

describe('administrator RBAC, MFA, and two-person rollout approval', () => {
  test('MFA sessions enforce roles and tenant responses mask phone numbers', async () => {
    const viewer = administrator('viewer.test', 'viewer');
    const bad = await api(app.baseUrl, '/api/v1/admin/session', {
      method: 'POST',
      body: { username: viewer.username, token: viewer.token, mfaCode: '000000' },
    });
    assert.equal(bad.status, 401);
    const token = await login(viewer);
    assert.equal((await api(app.baseUrl, '/api/v1/admin/overview')).status, 401);
    assert.equal((await api(app.baseUrl, '/api/v1/admin/overview', auth(token))).status, 200);
    assert.equal((await api(app.baseUrl, '/api/v1/admin/audit', auth(token))).status, 403);
    seedUserAndTenant(db, { userId: 'u_admin_view', phone: '+8613900090000', tenantId: 't_admin_view', status: 'ready' });
    const list = await api(app.baseUrl, '/api/v1/admin/tenants', auth(token));
    assert.equal(list.status, 200);
    assert.ok(!JSON.stringify(list.json).includes('+8613900090000'));
    assert.ok(JSON.stringify(list.json).includes('+861****0000'));
    const classified = await api(app.baseUrl, '/api/v1/admin/tenants/t_admin_view/classify', {
      ...auth(token),
      method: 'POST',
      body: { kind: 'synthetic', cohort: 'canary' },
    });
    assert.equal(classified.status, 403);
  });

  test('a second operator approves one immutable rollout plan exactly once', async () => {
    const first = administrator('operator.one', 'operator');
    const second = administrator('operator.two', 'operator');
    const firstToken = await login(first);
    const secondToken = await login(second);
    const releaseId = registerRelease(db, {
      schemaVersion: 1,
      sourceSha: 'e'.repeat(40),
      appVersion: '1.2.0',
      contractVersion: '1.0.0',
      rollbackSafeTo: '1.0.0',
      databaseSchemaVersion: 10,
      tenant: { image: 'tenant:admin-target', digest: `sha256:${'e'.repeat(64)}` },
      controlPlane: { image: 'cp:admin-target', digest: `sha256:${'f'.repeat(64)}` },
      createdAt: new Date().toISOString(),
      createdBy: 'test',
    }, 'test').release.id;
    const payload = {
      releaseId,
      mode: 'upgrade',
      tenantIds: ['t_admin_view'],
      globalConcurrency: 1,
      perHostConcurrency: 1,
    };
    const requested = await api(app.baseUrl, '/api/v1/admin/approvals', {
      ...auth(firstToken),
      method: 'POST',
      body: { action: 'rollout.create', payload, reason: 'commercial rollout test' },
    });
    assert.equal(requested.status, 201, JSON.stringify(requested.json));
    const approvalId = String((requested.json as { id: string }).id);
    const selfApproval = await api(app.baseUrl, `/api/v1/admin/approvals/${approvalId}/decision`, {
      ...auth(firstToken),
      method: 'POST',
      body: { decision: 'approved' },
    });
    assert.equal(selfApproval.status, 403);
    const approved = await api(app.baseUrl, `/api/v1/admin/approvals/${approvalId}/decision`, {
      ...auth(secondToken),
      method: 'POST',
      body: { decision: 'approved' },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    const created = await api(app.baseUrl, '/api/v1/admin/rollouts', {
      ...auth(firstToken),
      method: 'POST',
      body: { ...payload, approvalId },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal((created.json as { job: { status: string; mode: string } }).job.status, 'paused');
    assert.equal((created.json as { job: { status: string; mode: string } }).job.mode, 'upgrade');
    const replay = await api(app.baseUrl, '/api/v1/admin/rollouts', {
      ...auth(firstToken),
      method: 'POST',
      body: { ...payload, approvalId },
    });
    assert.equal(replay.status, 409);
    const adminOnly = await api(app.baseUrl, '/api/v1/admin/users', auth(firstToken));
    assert.equal(adminOnly.status, 403);
  });
});
