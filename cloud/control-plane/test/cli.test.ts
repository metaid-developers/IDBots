import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import type Database from 'better-sqlite3';
import { FakeDocker } from './fake-docker/index.mjs';
import { freshDb, MASTER_KEY, seedUserAndTenant, startTestApp, type TestApp } from './helpers.js';
import { DockerClient } from '../src/docker/client.js';
import { decryptSecret } from '../src/crypto.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let db: Database.Database;
let fake: FakeDocker;
let client: DockerClient;
let app: TestApp;
let workDir: string;
let cliEnv: NodeJS.ProcessEnv;

async function runCli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(PKG_ROOT, 'dist', 'cli.js'), ...args], {
      env: cliEnv,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

before(async () => {
  if (!existsSync(path.join(PKG_ROOT, 'dist', 'cli.js'))) {
    execSync('pnpm build', { cwd: PKG_ROOT, stdio: 'inherit' });
  }
  db = freshDb();
  fake = new FakeDocker();
  await fake.listen(0);
  client = new DockerClient(fake.url());
  app = await startTestApp({ db, dockerUrl: fake.url() });
  workDir = mkdtempSync(path.join(tmpdir(), 'cp-cli-test-'));

  cliEnv = {
    ...process.env,
    CP_DB_PATH: 'unused',
    CP_MASTER_KEY: MASTER_KEY.toString('base64'),
    CP_DOCKER_URL: fake.url(),
    CP_TENANT_IMAGE: 'fake-tenant:test',
    CP_TENANT_NETWORK: 'idbots-test',
  };
  // Point the CLI at the same db file the test process opened.
  const dbFile = (db.prepare('PRAGMA database_list').get() as { file: string }).file;
  cliEnv.CP_DB_PATH = dbFile;
});

after(async () => {
  await app.close();
  await fake.close();
  db.close();
  rmSync(workDir, { recursive: true, force: true });
});

async function startTenant(tenantId: string): Promise<void> {
  const created = await client.createContainer({
    name: `idb-${tenantId}`,
    image: 'fake-tenant:test',
    env: {
      IDBOTS_SERVER_MODE: '1',
      IDBOTS_TENANT_ID: tenantId,
      IDBOTS_GATEWAY_SECRET: 'test-secret',
      FAKE_TENANT_HEALTH_AFTER_MS: '0',
      FAKE_TENANT_PHASES: 'ready:0',
    },
  });
  await client.startContainer(created.Id);
}

async function containerIdOf(tenantId: string): Promise<string | null> {
  const list = await client.listContainers({ namePrefix: `idb-${tenantId}` });
  return list[0]?.Id ?? null;
}

function auditsFor(action: string): Array<{ actor: string; target: string }> {
  return db.prepare('SELECT actor, target FROM audit_log WHERE action = ?').all(action) as never;
}

describe('admin CLI (REQ-B-18)', () => {
  test('invite create prints the code; list shows it; disable flips the flag', async () => {
    const created = await runCli('invite', 'create', '--uses', '3', '--with-redeem', '--note', 'cli-test', '--as', 'op1');
    assert.equal(created.code, 0, created.stderr);
    const code = /code:\s*(\S+)/.exec(created.stdout)?.[1];
    assert.ok(code);
    const row = db.prepare('SELECT max_uses, with_redeem, note FROM invites WHERE code = ?').get(code) as {
      max_uses: number;
      with_redeem: number;
      note: string;
    };
    assert.deepEqual(row, { max_uses: 3, with_redeem: 1, note: 'cli-test' });
    assert.equal(auditsFor('invite.create').length, 1);

    const list = await runCli('invite', 'list');
    assert.equal(list.code, 0);
    assert.match(list.stdout, new RegExp(code));

    const disabled = await runCli('invite', 'disable', code, '--as', 'op1');
    assert.equal(disabled.code, 0, disabled.stderr);
    const flag = db.prepare('SELECT disabled FROM invites WHERE code = ?').get(code) as { disabled: number };
    assert.equal(flag.disabled, 1);
  });

  test('a mutating command without --as exits non-zero', async () => {
    const res = await runCli('invite', 'create', '--uses', '1');
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /--as/);
  });

  test('redeem import dedupes and stats never prints codes', async () => {
    const csv = path.join(workDir, 'codes.csv');
    writeFileSync(csv, '# batch\nCODE-AAA-1\nCODE-BBB-2\n\nCODE-AAA-1\n');
    const first = await runCli('redeem', 'import', '--file', csv, '--note', 't1', '--as', 'op1');
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /imported=2 skipped=1/);

    const again = await runCli('redeem', 'import', '--file', csv, '--as', 'op1');
    assert.match(again.stdout, /imported=0 skipped=3/);

    const stats = await runCli('redeem', 'stats');
    assert.equal(stats.code, 0);
    assert.match(stats.stdout, /imported=2 assigned=0 remaining=2/);
    assert.ok(!stats.stdout.includes('CODE-AAA-1') && !stats.stdout.includes('CODE-BBB-2'));
  });

  test('user disable suspends the tenant and stops the container; enable boots it', async () => {
    seedUserAndTenant(db, { userId: 'u_cli1', phone: '+8613900006001', tenantId: 't_cli1', status: 'ready' });
    await startTenant('t_cli1');

    const disabled = await runCli('user', 'disable', 'u_cli1', '--as', 'op2');
    assert.equal(disabled.code, 0, disabled.stderr);
    assert.equal((db.prepare("SELECT status FROM users WHERE id = 'u_cli1'").get() as { status: string }).status, 'disabled');
    const tenant = db.prepare("SELECT status FROM tenants WHERE id = 't_cli1'").get() as { status: string };
    assert.equal(tenant.status, 'suspended');
    const inspect = await client.inspectContainer((await containerIdOf('t_cli1'))!);
    assert.equal(inspect.State.Running, false);

    const enabled = await runCli('user', 'enable', 'u_cli1', '--as', 'op2');
    assert.equal(enabled.code, 0, enabled.stderr);
    assert.equal((db.prepare("SELECT status FROM users WHERE id = 'u_cli1'").get() as { status: string }).status, 'active');
    assert.equal((db.prepare("SELECT status FROM tenants WHERE id = 't_cli1'").get() as { status: string }).status, 'booting');
    const inspect2 = await client.inspectContainer((await containerIdOf('t_cli1'))!);
    assert.equal(inspect2.State.Running, true);
  });

  test('tenant classify persists the rollout group and writes an audit row', async () => {
    seedUserAndTenant(db, { userId: 'u_classify', phone: '+8613900006090', tenantId: 't_classify', status: 'ready' });
    const result = await runCli('tenant', 'classify', 't_classify', '--kind', 'synthetic', '--cohort', 'canary', '--as', 'op-classify');
    assert.equal(result.code, 0, result.stderr);
    const row = db.prepare("SELECT kind, cohort FROM tenants WHERE id = 't_classify'").get() as { kind: string; cohort: string };
    assert.deepEqual(row, { kind: 'synthetic', cohort: 'canary' });
    assert.equal(auditsFor('tenant.classify').length, 1);
    const show = await runCli('tenant', 'show', 't_classify');
    assert.match(show.stdout, /kind:\s+synthetic/);
    assert.match(show.stdout, /cohort:\s+canary/);
  });

  test('tenant stop/start/rerestart lifecycle', async () => {
    seedUserAndTenant(db, { userId: 'u_cli2', phone: '+8613900006002', tenantId: 't_cli2', status: 'ready' });
    await startTenant('t_cli2');

    assert.equal((await runCli('tenant', 'stop', 't_cli2', '--as', 'op3')).code, 0);
    assert.equal((db.prepare("SELECT status FROM tenants WHERE id = 't_cli2'").get() as { status: string }).status, 'stopped');

    assert.equal((await runCli('tenant', 'start', 't_cli2', '--as', 'op3')).code, 0);
    assert.equal((db.prepare("SELECT status FROM tenants WHERE id = 't_cli2'").get() as { status: string }).status, 'booting');

    assert.equal((await runCli('tenant', 'restart', 't_cli2', '--as', 'op3')).code, 0);
    const inspect = await client.inspectContainer((await containerIdOf('t_cli2'))!);
    assert.equal(inspect.State.Running, true);

    const show = await runCli('tenant', 'show', 't_cli2');
    assert.match(show.stdout, /container:\s+idb-t_cli2/);
    const list = await runCli('tenant', 'list', '--status', 'booting');
    assert.match(list.stdout, /t_cli2/);
  });

  test('rotate-secret recreates the container with a new secret', async () => {
    seedUserAndTenant(db, { userId: 'u_cli3', phone: '+8613900006003', tenantId: 't_cli3', status: 'ready', gatewaySecret: 'old-secret' });
    await startTenant('t_cli3');
    const before = await containerIdOf('t_cli3');

    const res = await runCli('tenant', 'rotate-secret', 't_cli3', '--as', 'op4');
    assert.equal(res.code, 0, res.stderr);

    const after = await containerIdOf('t_cli3');
    assert.ok(after);
    assert.notEqual(after, before, 'container recreated');
    const enc = (db.prepare("SELECT gateway_secret_enc FROM tenants WHERE id = 't_cli3'").get() as { gateway_secret_enc: string }).gateway_secret_enc;
    assert.notEqual(decryptSecret(MASTER_KEY, enc), 'old-secret');
    const inspect = await client.inspectContainer(after!);
    assert.ok(inspect.Config.Env.some((entry) => entry.startsWith('IDBOTS_GATEWAY_SECRET=')));
  });

  test('tenant logs prints the container log', async () => {
    const res = await runCli('tenant', 'logs', 't_cli3');
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /"msg":"listening"/);
  });

  test('tenant export writes a tar and marks an open deletion request exported', async () => {
    seedUserAndTenant(db, { userId: 'u_cli4', phone: '+8613900006004', tenantId: 't_cli4', status: 'ready' });
    await startTenant('t_cli4');
    db.prepare("INSERT INTO deletion_requests (user_id, reason, status, created_at) VALUES ('u_cli4', 'test', 'open', ?)").run(Date.now());

    const out = path.join(workDir, 't_cli4.tar');
    const res = await runCli('tenant', 'export', 't_cli4', '--to', out, '--as', 'op5');
    assert.equal(res.code, 0, res.stderr);
    const tar = readFileSync(out);
    assert.ok(tar.length > 512);
    assert.equal(tar.subarray(257, 262).toString('utf8'), 'ustar');
    // container is running again afterwards
    const inspect = await client.inspectContainer((await containerIdOf('t_cli4'))!);
    assert.equal(inspect.State.Running, true);
    const request = db.prepare("SELECT status FROM deletion_requests WHERE user_id = 'u_cli4'").get() as { status: string };
    assert.equal(request.status, 'exported');
  });

  test('deletion complete: wrong confirm refused, unexported refused, then success', async () => {
    // t_cli4: exported, confirm mismatch
    const wrong = await runCli('deletion', 'complete', '1', '--confirm', '+8610000000000', '--as', 'op6');
    assert.notEqual(wrong.code, 0);
    assert.match(wrong.stderr, /refusing/);

    // t_cli2: no deletion request at all -> not exported
    db.prepare("INSERT INTO deletion_requests (user_id, reason, status, created_at) VALUES ('u_cli2', 'test', 'open', ?)").run(Date.now());
    const requestId = (db.prepare("SELECT id FROM deletion_requests WHERE user_id = 'u_cli2'").get() as { id: number }).id;
    const notExported = await runCli('deletion', 'complete', String(requestId), '--confirm', '+8613900006002', '--as', 'op6');
    assert.notEqual(notExported.code, 0);
    assert.match(notExported.stderr, /export/);

    // success path on request 1 (+8613900006004)
    const ok = await runCli('deletion', 'complete', '1', '--confirm', '+8613900006004', '--as', 'op6');
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(await containerIdOf('t_cli4'), null, 'container removed');
    assert.equal(fake.volumes.has('idb-t_cli4-data'), false, 'volume removed');
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM tenants WHERE id = 't_cli4'").get() as { n: number };
    assert.equal(remaining.n, 0, 'tenant row removed');
    assert.equal((db.prepare('SELECT status FROM deletion_requests WHERE id = 1').get() as { status: string }).status, 'deleted');
    // user row stays (re-login semantics belong to a later phase)
    assert.ok(db.prepare("SELECT 1 FROM users WHERE id = 'u_cli4'").get());
  });

  test('mutating commands wrote audit rows with the --as operator', () => {
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor LIKE 'admin:%'")
      .get() as { n: number };
    assert.ok(rows.n >= 8, `expected many admin audit rows, got ${rows.n}`);
    const ops = db
      .prepare("SELECT DISTINCT actor FROM audit_log WHERE actor IN ('admin:op1','admin:op2','admin:op3','admin:op4','admin:op5','admin:op6')")
      .all() as Array<{ actor: string }>;
    assert.ok(ops.length >= 5);
  });
});
