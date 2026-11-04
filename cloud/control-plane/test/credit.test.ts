import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import type Database from 'better-sqlite3';
import { freshDb, seedUserAndTenant, startTestApp, MASTER_KEY, type TestApp } from './helpers.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TOKEN = 'admin-token-test-0f91';

let db: Database.Database;
let app: TestApp;
let base: string;
let origin: string;

interface JsonRes {
  status: number;
  body: any;
}

async function postCredit(payload: unknown, headers: Record<string, string> = {}): Promise<JsonRes> {
  const res = await fetch(`${base}/api/v1/admin/credit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, ...headers },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

function runCli(...args: string[]): { code: number; stdout: string; stderr: string } {
  const child = spawnSync(
    process.execPath,
    [path.join(PKG_ROOT, 'dist', 'cli.js'), ...args],
    {
      env: { ...process.env, CP_MASTER_KEY: MASTER_KEY.toString('base64'), CP_DB_PATH: cliDbFile, CP_DOCKER_URL: 'http+unix:///unused.sock' },
      encoding: 'utf8',
    },
  );
  return { code: child.status ?? -1, stdout: child.stdout, stderr: child.stderr };
}

let cliDbFile = '';

before(async () => {
  db = freshDb();
  const { FakeDocker } = await import('./fake-docker/index.mjs');
  const fake = new FakeDocker();
  await fake.listen(0);
  app = await startTestApp({ db, dockerUrl: fake.url(), adminApiToken: TOKEN });
  base = app.baseUrl;
  origin = base;
  cliDbFile = (db.prepare('PRAGMA database_list').get() as { file: string }).file;
  // CLI child processes need the shared file open; keep the fake alive until after.
  (app as unknown as { __fakeDocker?: unknown }).__fakeDocker = fake;
});

after(async () => {
  await (app as unknown as { __fakeDocker?: { close(): Promise<void> } }).__fakeDocker?.close();
  await app.close();
});

describe('credit route auth (bearer token surface)', () => {
  test('token unset in another app → route answers 404 (surface disabled)', async () => {
    const db2 = freshDb();
    const { FakeDocker } = await import('./fake-docker/index.mjs');
    const fake2 = new FakeDocker();
    await fake2.listen(0);
    const app2 = await startTestApp({ db: db2, dockerUrl: fake2.url() });
    try {
      const res = await fetch(`${app2.baseUrl}/api/v1/admin/credit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: app2.baseUrl, authorization: 'Bearer anything' },
        body: JSON.stringify({ userId: 'u_x', bytes: 1, reason: 'r' }),
      });
      assert.equal(res.status, 404);
    } finally {
      await app2.close();
      await fake2.close();
    }
  });

  test('missing bearer token → 401 (unauthorized call rejected)', async () => {
    const res = await postCredit({ userId: 'u_credit1', bytes: 1024, reason: 'no header at all' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'ADMIN_UNAUTHORIZED');
  });

  test('wrong bearer token → 401 (unauthorized call rejected)', async () => {
    const res = await postCredit(
      { userId: 'u_credit1', bytes: 1024, reason: 'wrong token' },
      { authorization: `Bearer wrong-${TOKEN}` },
    );
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'ADMIN_UNAUTHORIZED');
  });

  test('a user session cannot grant: cookie auth is not honored here', async () => {
    // The route is auth:false; no session cookie is read. The only accepted
    // credential is the bearer token, so a session-only request is 401.
    seedUserAndTenant(db, { userId: 'u_credit_user', phone: '+8613900000201', tenantId: 't_credit_user', status: 'active' });
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ userId: 'u_credit_user' }),
    });
    // Even if login succeeded and a cookie existed below, without the bearer
    // header the credit route refuses — the point is the token, not the user.
    const setCookie = login.headers.get('set-cookie');
    const res = await fetch(`${base}/api/v1/admin/credit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        ...(setCookie ? { cookie: setCookie.split(';')[0] } : {}),
      },
      body: JSON.stringify({ userId: 'u_credit_user', bytes: 1024, reason: 'self-credit attempt' }),
    });
    assert.equal(res.status, 401);
  });
});

describe('credit route grant paths', () => {
  before(() => {
    seedUserAndTenant(db, { userId: 'u_credit1', phone: '+8613900000202', tenantId: 't_credit1', status: 'active' });
  });

  test('normal grant → 201 with all five audit fields, ledger + audit rows', async () => {
    const res = await postCredit(
      {
        userId: 'u_credit1',
        bytes: 1073741824,
        reason: 'restore bundle bo_paidpaid1 (upstream grant g_1)',
        operator: 'alice',
        referenceKey: 'bo_paidpaid1',
      },
      { authorization: `Bearer ${TOKEN}` },
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.duplicate, false);
    assert.equal(res.body.userId, 'u_credit1');
    assert.equal(res.body.bytes, 1073741824);
    assert.ok(Number.isInteger(res.body.bytes));
    assert.equal(res.body.source, 'manual');
    assert.equal(res.body.actor, 'admin:alice');
    assert.ok(res.body.referenceKey === 'bo_paidpaid1');
    assert.ok(Number.isInteger(res.body.createdAt));

    const ledger = db
      .prepare('SELECT user_id, bytes_total, source, reason, actor, created_at FROM credit_ledger WHERE id = ?')
      .get(res.body.creditId) as any;
    assert.ok(ledger);
    assert.equal(ledger.user_id, 'u_credit1'); // whom
    assert.equal(ledger.bytes_total, 1073741824); // amount — integer bytes
    assert.equal(ledger.actor, 'admin:alice'); // who
    assert.ok(typeof ledger.created_at === 'number' && ledger.created_at > 0); // when
    assert.ok(ledger.reason.includes('bo_paidpaid1')); // basis

    const audit = db
      .prepare("SELECT actor, action, target, detail_json FROM audit_log WHERE action = 'credit.grant' ORDER BY id DESC LIMIT 1")
      .get() as any;
    assert.ok(audit);
    assert.equal(audit.actor, 'admin:alice');
    assert.equal(audit.target, 'u_credit1');
    assert.equal(JSON.parse(audit.detail_json).bytes, 1073741824);
  });

  test('duplicate reference key → 200 duplicate=true, exactly one ledger row', async () => {
    const res = await postCredit(
      { userId: 'u_credit1', bytes: 1073741824, reason: 'retry after uncertain timeout', operator: 'alice', referenceKey: 'bo_paidpaid1' },
      { authorization: `Bearer ${TOKEN}` },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.duplicate, true);
    const count = db
      .prepare('SELECT COUNT(*) AS c FROM credit_ledger WHERE reference_key = ?')
      .get('bo_paidpaid1') as { c: number };
    assert.equal(count.c, 1);
    // The returned row is the original grant, not a new one.
    assert.ok(Number.isInteger(res.body.creditId));
  });

  test('float / zero / negative bytes → 400 INVALID_BYTES (no float bookkeeping)', async () => {
    for (const bytes of [1.5, 0, -100, 'abc']) {
      const res = await postCredit(
        { userId: 'u_credit1', bytes, reason: 'invalid amounts', referenceKey: `bad-${String(bytes)}` },
        { authorization: `Bearer ${TOKEN}` },
      );
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_BYTES');
    }
  });

  test('missing reason → 400 MISSING_REASON; unknown user → 404 USER_NOT_FOUND', async () => {
    const resNoReason = await postCredit(
      { userId: 'u_credit1', bytes: 1024, reason: '' },
      { authorization: `Bearer ${TOKEN}` },
    );
    assert.equal(resNoReason.status, 400);
    assert.equal(resNoReason.body.error.code, 'MISSING_REASON');

    const resNoUser = await postCredit(
      { userId: 'u_nothere', bytes: 1024, reason: 'ghost user' },
      { authorization: `Bearer ${TOKEN}` },
    );
    assert.equal(resNoUser.status, 404);
    assert.equal(resNoUser.body.error.code, 'USER_NOT_FOUND');
  });

  test('list endpoint returns existing rows with the bearer token', async () => {
    const res = await fetch(`${base}/api/v1/admin/credit?userId=u_credit1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.credits.length >= 1);
    assert.ok(body.credits.every((c: any) => c.userId === 'u_credit1'));
  });
});

describe('credit CLI (REQ-B-18 operator surface)', () => {
  before(() => {
    if (!existsSync(path.join(PKG_ROOT, 'dist', 'cli.js'))) {
      throw new Error('dist/cli.js missing — run pnpm build first');
    }
    seedUserAndTenant(db, { userId: 'u_cli_credit', phone: '+8613900000203', tenantId: 't_cli_credit', status: 'active' });
  });

  test('mutating credit.grant without --as → refused (unauthorized call rejected)', () => {
    const res = runCli('credit', 'grant', '--user', 'u_cli_credit', '--bytes', '2048', '--reason', 'cli no-operator');
    assert.equal(res.code, 1);
    assert.match(res.stderr, /--as/);
  });

  test('normal grant prints the credit id; list shows it; audit row written', () => {
    const ok = runCli(
      'credit', 'grant',
      '--user', 'u_cli_credit',
      '--bytes', '2048',
      '--reason', 'manual goodwill (order unknown at the time)',
      '--reference', 'batch-1',
      '--as', 'bob',
    );
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /credit #\d+: 2048 bytes → user u_cli_credit/);

    const list = runCli('credit', 'list', '--user', 'u_cli_credit');
    assert.equal(list.code, 0);
    assert.match(list.stdout, /bytes=2048/);
    assert.match(list.stdout, /by=admin:bob/);
    assert.match(list.stdout, /reason=manual goodwill/);

    const audit = db
      .prepare("SELECT actor FROM audit_log WHERE action = 'credit.grant' AND target = 'u_cli_credit' ORDER BY id DESC LIMIT 1")
      .get() as { actor: string } | undefined;
    assert.equal(audit?.actor, 'admin:bob');
  });

  test('duplicate --reference → "already exists" and no second ledger row', () => {
    const before = (db.prepare('SELECT COUNT(*) AS c FROM credit_ledger WHERE user_id = ?').get('u_cli_credit') as { c: number }).c;
    const ok = runCli(
      'credit', 'grant',
      '--user', 'u_cli_credit',
      '--bytes', '2048',
      '--reason', 'cli duplicate attempt',
      '--reference', 'batch-1',
      '--as', 'bob',
    );
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /already exists/);
    const after = (db.prepare('SELECT COUNT(*) AS c FROM credit_ledger WHERE user_id = ?').get('u_cli_credit') as { c: number }).c;
    assert.equal(after, before);
  });

  test('non-integer bytes refused before any write', () => {
    const res = runCli('credit', 'grant', '--user', 'u_cli_credit', '--bytes', '1.5', '--reason', 'x', '--as', 'bob');
    assert.equal(res.code, 1);
    assert.match(res.stderr, /positive integer/);
  });
});

