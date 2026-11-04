#!/usr/bin/env node
/**
 * Plan B end-to-end proof — control plane + tenant, real code on both sides.
 *
 * Chain exercised here (no mocks inside either codebase):
 *   1. operator grants credit through the REAL admin route
 *      (POST /api/v1/admin/credit, bearer token)
 *   2. tenant pulls pending rows through the REAL tenant route
 *      (GET /api/v1/tenant/credit/pending, gateway-secret auth)
 *   3. the REAL tenant pull service redeems the code against a fake upstream
 *      that applies the SAME rules as the production traffic service
 *      (identity-signed redeem-code; same account + same code = idempotent)
 *   4. the REAL tenant pull service reports the result, and the ledger flips
 *      pending → applied exactly once
 *   5. a second pull redeems nothing
 *
 * The fake upstream is the only stand-in: it models the production traffic
 * service's redeem-code semantics (bytes credited once per code per account).
 * Everything on the control-plane and tenant sides is the shipped code.
 *
 * Prerequisites (both already part of the normal build):
 *   cloud/control-plane/dist   → cd cloud/control-plane && npx tsc -p tsconfig.build.json
 *   dist-electron/main         → pnpm run compile:electron
 *
 * Usage: node scripts/credit-apply-e2e.mjs
 */

import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CP_DIST = path.join(ROOT, 'cloud/control-plane/dist');
const TENANT_DIST = path.join(ROOT, 'dist-electron/main');

const { openDb } = await import(path.join(CP_DIST, 'db/index.js'));
const { loadConfig } = await import(path.join(CP_DIST, 'config.js'));
const { createPublicServer, createMetricsServer } = await import(path.join(CP_DIST, 'server.js'));
const { DockerClient } = await import(path.join(CP_DIST, 'docker/client.js'));
const { FakeSmsProvider } = await import(path.join(CP_DIST, 'sms.js'));
const { MetricsRegistry } = await import(path.join(CP_DIST, 'metrics.js'));
const { encryptSecret } = await import(path.join(CP_DIST, 'crypto.js'));
const { runCreditPullOnce } = await import(
  path.join(TENANT_DIST, 'services/creditPullService.js')
);

const MASTER_KEY = Buffer.alloc(32, 7);
const ADMIN_TOKEN = 'e2e-admin-token';
const TENANT_ID = 't_e2e_credit';
const USER_ID = 'u_e2e_credit';
const GATEWAY_SECRET = 'e2e-tenant-gateway-secret';
const CODE = 'IDB-E2E0-50GB-AAAA';
const FIFTY_GB = 53687091200;
const START_BALANCE = 60000000;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

function line(label, value) {
  console.log(`${label.padEnd(26)} ${value}`);
}

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), 'credit-e2e-'));
  const dbFile = path.join(dir, 'cp.sqlite');
  const db = openDb(dbFile);

  // --- seed: one active user + one ready tenant ----------------------------
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (id, phone_e164, display_name, locale, status, created_at)
     VALUES (?, '+8613900000301', 'E2E User', 'zh', 'active', ?)`,
  ).run(USER_ID, now);
  db.prepare(
    `INSERT INTO tenants (
       id, user_id, host_id, container_name, volume_name, image, previous_image,
       gateway_secret_enc, status, created_at, updated_at
     ) VALUES (?, ?, 'h_e2e', ?, ?, 'tenant:e2e', NULL, ?, 'ready', ?, ?)`,
  ).run(
    TENANT_ID,
    USER_ID,
    `idb-${TENANT_ID}`,
    `idb-${TENANT_ID}-data`,
    encryptSecret(MASTER_KEY, GATEWAY_SECRET),
    now,
    now,
  );

  const port = await freePort();
  const metricsPort = await freePort();
  const env = {
    CP_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    CP_LISTEN: `127.0.0.1:${port}`,
    CP_METRICS_LISTEN: `127.0.0.1:${metricsPort}`,
    CP_DB_PATH: dbFile,
    CP_MASTER_KEY: MASTER_KEY.toString('base64'),
    CP_DOCKER_URL: 'http+unix:///nonexistent.sock',
    CP_TENANT_IMAGE: 'tenant:e2e',
    CP_TENANT_NETWORK: 'idbots-e2e',
    CP_SMS_MODE: 'fake',
    CP_FAKE_SMS_NUMBERS: '+8613900000301',
    CP_ADMIN_API_TOKEN: ADMIN_TOKEN,
  };
  const config = loadConfig(env);
  const app = {
    config,
    db,
    docker: new DockerClient(env.CP_DOCKER_URL),
    sms: new FakeSmsProvider(config.fakeSmsNumbers),
    poller: null,
    metrics: new MetricsRegistry(),
  };

  const server = createPublicServer(app);
  const metricsServer = createMetricsServer(app);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  await new Promise((resolve) => metricsServer.listen(metricsPort, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${port}`;
  const origin = base;

  // --- fake upstream traffic service (redeem-code semantics) --------------
  const upstream = {
    grantedBytesTotal: START_BALANCE,
    balanceBytes: START_BALANCE,
    redeemCalls: [],
    applied: new Map(),
  };
  const redeem = async (code) => {
    upstream.redeemCalls.push(code);
    const seen = upstream.applied.get(code);
    if (seen) return { ...seen }; // same account + same code: idempotent
    upstream.grantedBytesTotal += FIFTY_GB;
    upstream.balanceBytes += FIFTY_GB;
    const result = { codeId: 501, trafficBytes: FIFTY_GB, balanceAfter: upstream.balanceBytes };
    upstream.applied.set(code, result);
    return { ...result };
  };

  const logs = [];
  const log = (level, msg, extra) => logs.push({ level, msg, extra });

  console.log('\n=== plan B end-to-end (real control plane + real tenant code) ===\n');
  line('tenant upstream before', `${upstream.grantedBytesTotal} bytes`);

  // 1. operator records the grant (real admin route)
  const grantRes = await fetch(`${base}/api/v1/admin/credit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({
      userId: USER_ID,
      bytes: FIFTY_GB,
      reason: 'e2e: smoke 50GB grant',
      operator: 'e2e',
      referenceKey: 'smoke-20261105-plus50gb',
      applyCode: CODE,
    }),
  });
  const grant = await grantRes.json();
  if (grantRes.status !== 201) throw new Error(`admin grant failed: ${grantRes.status} ${JSON.stringify(grant)}`);
  line('ledger grant', `#${grant.creditId} ${grant.bytes} bytes apply=${grant.applyState} code=${grant.hasApplyCode}`);

  // 2. tenant pull #1 (real service, real tenant route)
  const tick1 = await runCreditPullOnce({
    env: {
      IDBOTS_CONTROL_PLANE_URL: base,
      IDBOTS_TENANT_ID: TENANT_ID,
      IDBOTS_GATEWAY_SECRET: GATEWAY_SECRET,
    },
    redeem,
    log,
  });
  line('tick 1 applied', JSON.stringify(tick1.applied));
  line('tick 1 failed', JSON.stringify(tick1.failed));
  line('upstream after tick 1', `${upstream.grantedBytesTotal} bytes`);
  line('redeem calls', String(upstream.redeemCalls.length));

  // 3. pull #2 must find nothing to apply
  const tick2 = await runCreditPullOnce({
    env: {
      IDBOTS_CONTROL_PLANE_URL: base,
      IDBOTS_TENANT_ID: TENANT_ID,
      IDBOTS_GATEWAY_SECRET: GATEWAY_SECRET,
    },
    redeem,
    log,
  });
  line('tick 2 applied', JSON.stringify(tick2.applied));
  line('redeem calls (total)', String(upstream.redeemCalls.length));

  const row = db.prepare('SELECT * FROM credit_ledger WHERE id = ?').get(grant.creditId);
  line('ledger state', `${row.apply_state} by=${row.applied_by} bytes=${row.applied_bytes}`);
  line('ledger evidence', String(row.applied_evidence));

  // --- assertions ---------------------------------------------------------
  const failures = [];
  const check = (ok, label) => {
    if (!ok) failures.push(label);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  };
  console.log('\n--- assertions ---');
  check(tick1.applied.length === 1 && tick1.applied[0] === grant.creditId, 'tick 1 applies the granted credit');
  check(tick2.applied.length === 0, 'tick 2 applies nothing (idempotent)');
  check(upstream.redeemCalls.length === 1, 'upstream redeemed exactly once');
  check(upstream.grantedBytesTotal === START_BALANCE + FIFTY_GB, 'upstream grantedBytesTotal grew 60MB → 60MB + 50GB');
  check(upstream.grantedBytesTotal >= FIFTY_GB, 'upstream grantedBytesTotal ≥ 50GB');
  check(row.apply_state === 'applied' && row.applied_by === TENANT_ID, 'ledger marked applied by the tenant');
  check(row.applied_bytes === FIFTY_GB, 'ledger records the applied byte count');
  check(!logs.some((entry) => JSON.stringify(entry).includes(CODE)), 'redeem code never appears in logs');

  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => metricsServer.close(resolve));
  db.close();

  if (failures.length > 0) {
    console.error(`\n${failures.length} assertion(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log('\nALL CHECKS PASSED');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
