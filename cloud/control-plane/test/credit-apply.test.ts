import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../src/db/migrations.js';
import { grantCredit } from '../src/services/creditService.js';
import { freshDb, seedUserAndTenant, startTestApp, type TestApp } from './helpers.js';

/**
 * Plan B — tenant pulls pending credit and reports the application result.
 *
 * Covers the five acceptance behaviours of this slice:
 *   1. tenant authentication (its own gateway secret; no cross-tenant reads)
 *   2. only pending, applicable rows are returned (bundle-order rows were
 *      already credited upstream and must never be re-applied)
 *   3. apply → row flips once; a second report is a duplicate, not a re-apply
 *   4. failure keeps the row pending and counts the attempt (retryable)
 *   5. the operator can attach the single-use code a pending grant is worth
 */

const ADMIN_TOKEN = 'admin-token-credit-apply';

let db: Database.Database;
let t: TestApp;

const TENANT_A = { tenantId: 't_apply_a', userId: 'u_apply_a', phone: '+8613900000201', secret: 'secret-tenant-a' };
const TENANT_B = { tenantId: 't_apply_b', userId: 'u_apply_b', phone: '+8613900000202', secret: 'secret-tenant-b' };

interface PendingBody {
  tenantId?: string;
  userId?: string;
  credits?: Array<{ creditId: number; bytes: number; code: string; referenceKey: string | null }>;
  blocked?: Array<{ creditId: number; reason: string }>;
  error?: { code: string };
}

async function tenantGet(tenantId: string, secret: string): Promise<{ status: number; body: PendingBody }> {
  const res = await fetch(`${t.baseUrl}/api/v1/tenant/credit/pending`, {
    headers: { 'x-tenant-id': tenantId, authorization: `Bearer ${secret}` },
  });
  return { status: res.status, body: (await res.json()) as PendingBody };
}

async function tenantApply(
  tenantId: string,
  secret: string,
  creditId: number,
  payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${t.baseUrl}/api/v1/tenant/credit/${creditId}/apply-result`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': tenantId,
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function ledgerRow(id: number): Record<string, unknown> {
  return db.prepare('SELECT * FROM credit_ledger WHERE id = ?').get(id) as Record<string, unknown>;
}

let pendingA = 0;
let pendingB = 0;
let blockedId = 0;

before(async () => {
  db = freshDb();
  const { FakeDocker } = await import('./fake-docker/index.mjs');
  const fake = new FakeDocker();
  await fake.listen(0);
  t = await startTestApp({ db, dockerUrl: fake.url(), adminApiToken: ADMIN_TOKEN });
  (t as unknown as { __fakeDocker?: unknown }).__fakeDocker = fake;

  seedUserAndTenant(db, {
    userId: TENANT_A.userId,
    phone: TENANT_A.phone,
    tenantId: TENANT_A.tenantId,
    status: 'ready',
    gatewaySecret: TENANT_A.secret,
  });
  seedUserAndTenant(db, {
    userId: TENANT_B.userId,
    phone: TENANT_B.phone,
    tenantId: TENANT_B.tenantId,
    status: 'ready',
    gatewaySecret: TENANT_B.secret,
  });

  // A: one applicable manual grant, one grant with no code yet, one bundle
  // order (already credited upstream → never applicable).
  pendingA = grantCredit(t.app, {
    userId: TENANT_A.userId,
    bytes: 53687091200,
    reason: 'smoke 50GB grant',
    source: 'manual',
    actor: 'admin:test',
    referenceKey: 'smoke-apply-50gb',
    applyCode: 'IDB-TEST-0001-AAAA',
  }).creditId;
  blockedId = grantCredit(t.app, {
    userId: TENANT_A.userId,
    bytes: 104857600,
    reason: 'no code attached yet',
    source: 'manual',
    actor: 'admin:test',
    referenceKey: 'no-code-yet',
  }).creditId;
  grantCredit(t.app, {
    userId: TENANT_A.userId,
    bytes: 104857600,
    reason: 'bundle order already credited upstream',
    source: 'bundle-order',
    actor: 'admin:test',
    referenceKey: 'bo_already_credited',
    applyCode: 'IDB-TEST-0002-BBBB',
  });

  // B: one applicable grant, to prove isolation.
  pendingB = grantCredit(t.app, {
    userId: TENANT_B.userId,
    bytes: 209715200,
    reason: 'other tenant grant',
    source: 'manual',
    actor: 'admin:test',
    referenceKey: 'tenant-b-grant',
    applyCode: 'IDB-TEST-0003-CCCC',
  }).creditId;
});

after(async () => {
  await (t as unknown as { __fakeDocker?: { close(): Promise<void> } }).__fakeDocker?.close();
  await t.close();
});

describe('tenant authentication', () => {
  test('no credentials → 401 and no data', async () => {
    const res = await fetch(`${t.baseUrl}/api/v1/tenant/credit/pending`);
    assert.equal(res.status, 401);
    const body = (await res.json()) as PendingBody;
    assert.equal(body.error?.code, 'TENANT_UNAUTHORIZED');
    assert.equal(body.credits, undefined);
  });

  test('wrong secret → 401 (uniform with unknown tenant)', async () => {
    const res = await tenantGet(TENANT_A.tenantId, 'not-the-secret');
    assert.equal(res.status, 401);
    assert.equal(res.body.error?.code, 'TENANT_UNAUTHORIZED');
  });

  test('unknown tenant id → 401, never a hint that it does not exist', async () => {
    const res = await tenantGet('t_does_not_exist', 'secret-tenant-a');
    assert.equal(res.status, 401);
    assert.equal(res.body.error?.code, 'TENANT_UNAUTHORIZED');
  });
});

describe('pending pull is scoped to the calling tenant', () => {
  test('tenant A sees only its own rows, bundle-order excluded, code-less reported blocked', async () => {
    const res = await tenantGet(TENANT_A.tenantId, TENANT_A.secret);
    assert.equal(res.status, 200);
    assert.equal(res.body.tenantId, TENANT_A.tenantId);
    assert.equal(res.body.userId, TENANT_A.userId);
    const ids = (res.body.credits ?? []).map((c) => c.creditId);
    assert.deepEqual(ids, [pendingA]);
    assert.equal(res.body.credits?.[0].bytes, 53687091200);
    assert.equal(res.body.credits?.[0].code, 'IDB-TEST-0001-AAAA');
    assert.deepEqual(
      (res.body.blocked ?? []).map((b) => b.creditId),
      [blockedId],
    );
    assert.equal(res.body.blocked?.[0].reason, 'NO_APPLICATION_CODE');
  });

  test('tenant B never sees tenant A rows (and vice versa)', async () => {
    const b = await tenantGet(TENANT_B.tenantId, TENANT_B.secret);
    assert.equal(b.status, 200);
    assert.deepEqual((b.body.credits ?? []).map((c) => c.creditId), [pendingB]);
    const a = await tenantGet(TENANT_A.tenantId, TENANT_A.secret);
    assert.ok(!(a.body.credits ?? []).some((c) => c.creditId === pendingB));
  });

  test('bundle-order rows are never applicable (already credited upstream)', () => {
    const row = db
      .prepare("SELECT apply_state FROM credit_ledger WHERE reference_key = 'bo_already_credited'")
      .get() as { apply_state: string };
    assert.equal(row.apply_state, 'not-required');
  });
});

describe('apply result', () => {
  test('success flips pending → applied once and stores the evidence', async () => {
    const res = await tenantApply(TENANT_A.tenantId, TENANT_A.secret, pendingA, {
      ok: true,
      evidence: { codeId: 42, trafficBytes: 53687091200, balanceAfter: 53747010000 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.applied, true);
    assert.equal(res.body.duplicate, false);
    assert.equal(res.body.applyState, 'applied');
    const row = ledgerRow(pendingA);
    assert.equal(row.apply_state, 'applied');
    assert.equal(row.applied_by, TENANT_A.tenantId);
    assert.equal(row.applied_bytes, 53687091200);
    assert.equal(row.applied_at !== null, true);
    assert.deepEqual(JSON.parse(String(row.applied_evidence)), {
      codeId: 42,
      trafficBytes: 53687091200,
      balanceAfter: 53747010000,
    });
  });

  test('a repeated report is a duplicate — never a second application', async () => {
    const res = await tenantApply(TENANT_A.tenantId, TENANT_A.secret, pendingA, {
      ok: true,
      evidence: { codeId: 42, trafficBytes: 53687091200 },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.applied, false);
    assert.equal(res.body.duplicate, true);
    const row = ledgerRow(pendingA);
    assert.equal(row.apply_state, 'applied');
  });

  test('the applied row leaves the pending set', async () => {
    const res = await tenantGet(TENANT_A.tenantId, TENANT_A.secret);
    assert.ok(!(res.body.credits ?? []).some((c) => c.creditId === pendingA));
  });

  test('tenant B cannot mark tenant A credit applied (404, no leak)', async () => {
    const res = await tenantApply(TENANT_B.tenantId, TENANT_B.secret, blockedId, { ok: true });
    assert.equal(res.status, 404);
    assert.equal((res.body.error as { code: string }).code, 'CREDIT_NOT_FOUND');
    assert.equal(ledgerRow(blockedId).apply_state, 'pending');
  });

  test('upstream failure keeps the row pending and counts the attempt (retryable)', async () => {
    const res = await tenantApply(TENANT_A.tenantId, TENANT_A.secret, blockedId, {
      ok: false,
      error: 'traffic_redeem_failed: upstream 503',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.applied, false);
    assert.equal(res.body.applyAttempts, 1);
    const row = ledgerRow(blockedId);
    assert.equal(row.apply_state, 'pending');
    assert.match(String(row.last_apply_error), /upstream 503/);
    const pull = await tenantGet(TENANT_A.tenantId, TENANT_A.secret);
    assert.deepEqual((pull.body.blocked ?? []).map((b) => b.creditId), [blockedId]);
  });
});

describe('operator attaches the application code', () => {
  async function adminAttach(creditId: number, code: string, token = ADMIN_TOKEN): Promise<Response> {
    return fetch(`${t.baseUrl}/api/v1/admin/credit/${creditId}/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: t.baseUrl, authorization: `Bearer ${token}` },
      body: JSON.stringify({ code, operator: 'ops' }),
    });
  }

  test('requires the admin token', async () => {
    const res = await adminAttach(blockedId, 'IDB-TEST-9999-ZZZZ', 'wrong-token');
    assert.equal(res.status, 401);
  });

  test('attaching a code makes the blocked grant applicable on the next pull', async () => {
    const res = await adminAttach(blockedId, 'IDB-TEST-0004-DDDD');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { hasApplyCode: boolean; applyState: string };
    assert.equal(body.hasApplyCode, true);
    assert.equal(body.applyState, 'pending');

    const pull = await tenantGet(TENANT_A.tenantId, TENANT_A.secret);
    assert.deepEqual((pull.body.credits ?? []).map((c) => c.creditId), [blockedId]);
    assert.equal(pull.body.credits?.[0].code, 'IDB-TEST-0004-DDDD');
    assert.deepEqual(pull.body.blocked, []);
  });

  test('the code is never returned by the admin list', async () => {
    const res = await fetch(`${t.baseUrl}/api/v1/admin/credit?userId=${TENANT_A.userId}`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!text.includes('IDB-TEST-0004-DDDD'));
  });

  test('an applied grant refuses a new code (no re-arming)', async () => {
    const res = await adminAttach(pendingA, 'IDB-TEST-0005-EEEE');
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'CREDIT_NOT_PENDING');
  });
});

describe('migration 4 preserves existing ledger rows', () => {
  test('v3 rows survive: manual stays pending, bundle-order becomes not-required', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cp-mig-'));
    const legacy = new Database(path.join(dir, 'legacy.sqlite'));
    legacy.pragma('journal_mode = WAL');
    legacy.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
    for (const migration of MIGRATIONS.filter((m) => m.version <= 3)) {
      legacy.transaction(() => {
        migration.up(legacy);
        legacy
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, Date.now());
      })();
    }
    legacy
      .prepare(
        `INSERT INTO users (id, phone_e164, display_name, locale, status, created_at)
         VALUES ('u_legacy', '+8613900000203', 'Legacy', 'zh', 'active', 1)`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO credit_ledger (id, user_id, bytes_total, source, reason, actor, reference_key, created_at)
         VALUES (1, 'u_legacy', 53687091200, 'manual', 'production smoke row', 'admin:smoke', 'smoke-20261105-plus50gb', 1),
                (2, 'u_legacy', 104857600, 'bundle-order', 'paid order', 'admin:ops', 'bo_1', 2)`,
      )
      .run();
    const mig4 = MIGRATIONS.find((m) => m.version === 4);
    assert.ok(mig4);
    mig4.up(legacy);
    const rows = legacy
      .prepare('SELECT id, bytes_total, reference_key, apply_state, apply_code_enc FROM credit_ledger ORDER BY id')
      .all() as Array<{ id: number; bytes_total: number; reference_key: string; apply_state: string; apply_code_enc: string | null }>;
    assert.equal(rows.length, 2);
    assert.deepEqual(
      { id: rows[0].id, bytes: rows[0].bytes_total, ref: rows[0].reference_key, state: rows[0].apply_state },
      { id: 1, bytes: 53687091200, ref: 'smoke-20261105-plus50gb', state: 'pending' },
    );
    assert.equal(rows[1].apply_state, 'not-required');
    assert.equal(rows[0].apply_code_enc, null);
    legacy.close();
  });
});
