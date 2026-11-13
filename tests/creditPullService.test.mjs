import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * Plan B, tenant half: pull pending credit grants from the control plane and
 * apply them to the upstream traffic account through the identity-signed
 * redeem-code channel.
 *
 * The fake control plane below mirrors the real route semantics
 * (cloud/control-plane/src/routes/tenantCredit.ts): tenant-scoped bearer auth,
 * only pending rows, an apply-report flips the row exactly once, a failure
 * report keeps it pending. The fake upstream mirrors the real redemption rule
 * (same account + same code = idempotent, one grant).
 */

const {
  CREDIT_PULL_INTERVAL_MS,
  readCreditPullConfig,
  runCreditPullOnce,
  startCreditPullLoop,
} = await import('../dist-electron/main/services/creditPullService.js');

const TENANT_ID = 't_credit_test';
const SECRET = 'gateway-secret-for-tests';
const CODE = 'IDB-TEST-4321-WXYZ';
const FIFTY_GB = 53687091200;

function startFakeControlPlane(initialCredits) {
  const state = {
    credits: initialCredits.map((c) => ({ ...c })),
    reports: [],
    pendingCalls: 0,
    rejectAuth: false,
    failReports: 0,
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const authorised =
        !state.rejectAuth &&
        req.headers['x-tenant-id'] === TENANT_ID &&
        req.headers.authorization === `Bearer ${SECRET}`;
      if (!authorised) return send(401, { error: { code: 'TENANT_UNAUTHORIZED' } });

      if (req.method === 'GET' && url.pathname === '/api/v1/tenant/credit/pending') {
        state.pendingCalls += 1;
        return send(200, { tenantId: TENANT_ID, userId: 'u_credit_test', credits: state.credits, blocked: [] });
      }
      const match = url.pathname.match(/^\/api\/v1\/tenant\/credit\/(\d+)\/apply-result$/);
      if (req.method === 'POST' && match) {
        const creditId = Number(match[1]);
        if (state.failReports > 0) {
          state.failReports -= 1;
          return send(500, { error: { code: 'INTERNAL' } });
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        state.reports.push({ creditId, body });
        if (body.ok === true) {
          state.credits = state.credits.filter((c) => c.creditId !== creditId);
          return send(200, { creditId, applied: true, duplicate: false, applyState: 'applied' });
        }
        return send(200, { creditId, applied: false, applyAttempts: 1, applyState: 'pending' });
      }
      return send(404, { error: { code: 'NOT_FOUND' } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        state,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Fake upstream traffic account: identity-signed redeem, idempotent per code. */
function createFakeUpstream({ failFirst = 0 } = {}) {
  const upstream = {
    grantedBytesTotal: 60000000,
    balanceBytes: 60000000,
    redeemCalls: [],
    appliedCodes: new Map(),
    failNext: failFirst,
  };
  upstream.redeem = async (code) => {
    upstream.redeemCalls.push(code);
    if (upstream.failNext > 0) {
      upstream.failNext -= 1;
      const error = new Error('upstream traffic service unavailable');
      error.code = 'traffic_redeem_failed';
      error.serviceMessage = '503 from upstream';
      throw error;
    }
    const existing = upstream.appliedCodes.get(code);
    if (existing) {
      // Same account + same code: idempotent, no second credit.
      return { ...existing };
    }
    upstream.grantedBytesTotal += FIFTY_GB;
    upstream.balanceBytes += FIFTY_GB;
    const result = { codeId: 101, trafficBytes: FIFTY_GB, balanceAfter: upstream.balanceBytes };
    upstream.appliedCodes.set(code, result);
    return { ...result };
  };
  return upstream;
}

function envFor(controlPlaneUrl) {
  return {
    IDBOTS_CONTROL_PLANE_URL: controlPlaneUrl,
    IDBOTS_TENANT_ID: TENANT_ID,
    IDBOTS_GATEWAY_SECRET: SECRET,
  };
}

function quietLogger() {
  const lines = [];
  const log = (level, msg, extra) => lines.push(JSON.stringify({ level, msg, extra }));
  return { lines, log };
}

test('config requires all three pieces — a partial env disables the pull', () => {
  assert.equal(readCreditPullConfig({}), null);
  assert.equal(readCreditPullConfig({ IDBOTS_CONTROL_PLANE_URL: 'http://cp' }), null);
  assert.equal(
    readCreditPullConfig({ IDBOTS_CONTROL_PLANE_URL: 'http://cp/', IDBOTS_TENANT_ID: 't', IDBOTS_GATEWAY_SECRET: 's' })
      ?.controlPlaneUrl,
    'http://cp',
  );
});

test('missing config: one skipped tick, no network, no redeem', async () => {
  const upstream = createFakeUpstream();
  let fetched = 0;
  const result = await runCreditPullOnce({
    env: {},
    fetchImpl: async () => {
      fetched += 1;
      throw new Error('must not be called');
    },
    redeem: upstream.redeem,
    log: quietLogger().log,
  });
  assert.match(result.skipped, /disabled/);
  assert.equal(fetched, 0);
  assert.equal(upstream.redeemCalls.length, 0);
});

test('happy path: pull → redeem → report applied; a second tick redeems nothing', async () => {
  const cp = await startFakeControlPlane([
    { creditId: 1, bytes: FIFTY_GB, reason: 'smoke 50GB', referenceKey: 'smoke-20261105-plus50gb', createdAt: 1, code: CODE },
  ]);
  const upstream = createFakeUpstream();
  const logger = quietLogger();
  try {
    const first = await runCreditPullOnce({
      env: envFor(cp.url),
      redeem: upstream.redeem,
      log: logger.log,
    });
    assert.deepEqual(first.applied, [1]);
    assert.deepEqual(first.failed, []);
    assert.equal(upstream.grantedBytesTotal, 60000000 + FIFTY_GB);
    assert.deepEqual(upstream.redeemCalls, [CODE]);
    assert.equal(cp.state.reports.length, 1);
    assert.equal(cp.state.reports[0].body.ok, true);
    assert.deepEqual(cp.state.reports[0].body.evidence, {
      codeId: 101,
      trafficBytes: FIFTY_GB,
      balanceAfter: 60000000 + FIFTY_GB,
    });

    const second = await runCreditPullOnce({ env: envFor(cp.url), redeem: upstream.redeem, log: logger.log });
    assert.deepEqual(second.applied, []);
    assert.equal(upstream.redeemCalls.length, 1, 'a settled row must never be redeemed twice');
    assert.equal(upstream.grantedBytesTotal, 60000000 + FIFTY_GB);
    assert.ok(logger.lines.every((line) => !line.includes(CODE)), 'the redeem code must never be logged');
  } finally {
    await cp.close();
  }
});

test('upstream failure keeps the row pending; the next tick retries and succeeds', async () => {
  const cp = await startFakeControlPlane([
    { creditId: 7, bytes: FIFTY_GB, reason: 'retry case', referenceKey: null, createdAt: 1, code: CODE },
  ]);
  const upstream = createFakeUpstream({ failFirst: 1 });
  const logger = quietLogger();
  try {
    const failedTick = await runCreditPullOnce({ env: envFor(cp.url), redeem: upstream.redeem, log: logger.log });
    assert.deepEqual(failedTick.applied, []);
    assert.equal(failedTick.failed.length, 1);
    assert.equal(failedTick.failed[0].creditId, 7);
    assert.equal(cp.state.credits.length, 1, 'the ledger row stays pending after an upstream failure');
    assert.equal(cp.state.reports.at(-1).body.ok, false);
    assert.equal(upstream.grantedBytesTotal, 60000000);

    const retried = await runCreditPullOnce({ env: envFor(cp.url), redeem: upstream.redeem, log: logger.log });
    assert.deepEqual(retried.applied, [7]);
    assert.equal(upstream.grantedBytesTotal, 60000000 + FIFTY_GB);
    assert.equal(cp.state.credits.length, 0);
  } finally {
    await cp.close();
  }
});

test('crash between redeem and report: retry is idempotent upstream — credited once', async () => {
  const cp = await startFakeControlPlane([
    { creditId: 9, bytes: FIFTY_GB, reason: 'crash window', referenceKey: null, createdAt: 1, code: CODE },
  ]);
  const upstream = createFakeUpstream();
  cp.state.failReports = 1; // first apply-report fails after the bytes landed
  try {
    const first = await runCreditPullOnce({ env: envFor(cp.url), redeem: upstream.redeem, log: quietLogger().log });
    assert.deepEqual(first.applied, []);
    assert.equal(first.failed.length, 1);
    assert.equal(upstream.grantedBytesTotal, 60000000 + FIFTY_GB, 'bytes landed upstream');
    assert.equal(cp.state.credits.length, 1, 'ledger still pending because the report failed');

    const second = await runCreditPullOnce({ env: envFor(cp.url), redeem: upstream.redeem, log: quietLogger().log });
    assert.deepEqual(second.applied, [9]);
    assert.equal(upstream.redeemCalls.length, 2, 'the retry re-submits the same code');
    assert.equal(upstream.grantedBytesTotal, 60000000 + FIFTY_GB, 'idempotent redemption: credited exactly once');
    assert.equal(cp.state.credits.length, 0);
  } finally {
    await cp.close();
  }
});

test('control-plane auth rejection: nothing is redeemed', async () => {
  const cp = await startFakeControlPlane([
    { creditId: 3, bytes: FIFTY_GB, reason: 'auth', referenceKey: null, createdAt: 1, code: CODE },
  ]);
  cp.state.rejectAuth = true;
  const upstream = createFakeUpstream();
  try {
    const result = await runCreditPullOnce({ env: envFor(cp.url), redeem: upstream.redeem, log: quietLogger().log });
    assert.match(result.skipped, /401/);
    assert.equal(upstream.redeemCalls.length, 0);
  } finally {
    await cp.close();
  }
});

test('blocked grants (no application code) are reported, never redeemed', async () => {
  const cp = await startFakeControlPlane([]);
  cp.state.credits = [];
  const upstream = createFakeUpstream();
  const logger = quietLogger();
  try {
    // The fake CP returns credits+blocked together only if we shape it that way;
    // simulate by adding a credit without a code (the real CP puts those in
    // `blocked`, covered by the control-plane test suite).
    cp.state.credits = [{ creditId: 5, bytes: FIFTY_GB, reason: 'no code', referenceKey: null, createdAt: 1 }];
    const result = await runCreditPullOnce({ env: envFor(cp.url), redeem: upstream.redeem, log: logger.log });
    assert.deepEqual(result.applied, []);
    assert.equal(upstream.redeemCalls.length, 0);
  } finally {
    await cp.close();
  }
});

test('loop: a failed credit is gated by backoff, then retried after the window', async () => {
  const cp = await startFakeControlPlane([
    { creditId: 11, bytes: FIFTY_GB, reason: 'backoff', referenceKey: null, createdAt: 1, code: CODE },
  ]);
  const upstream = createFakeUpstream({ failFirst: 1 });
  let clock = 1_000_000;
  const loop = startCreditPullLoop({
    env: envFor(cp.url),
    redeem: upstream.redeem,
    log: quietLogger().log,
    initialDelayMs: 10_000, // never fires in this test; we drive runNow()
    intervalMs: CREDIT_PULL_INTERVAL_MS,
    now: () => clock,
  });
  try {
    const first = await loop.runNow();
    assert.equal(first.failed.length, 1);
    assert.equal(upstream.redeemCalls.length, 1);

    const gated = await loop.runNow();
    assert.deepEqual(gated, { applied: [], failed: [], blocked: [] });
    assert.equal(upstream.redeemCalls.length, 1, 'inside the backoff window no redeem is attempted');

    clock += 61_000; // past CREDIT_RETRY_BASE_MS
    const retried = await loop.runNow();
    assert.deepEqual(retried.applied, [11]);
    assert.equal(upstream.grantedBytesTotal, 60000000 + FIFTY_GB);
  } finally {
    loop.stop();
    await cp.close();
  }
});
