import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const {
  BOOTSTRAP_INVITE_GRANT_TICKET_ENV,
  INVITE_GRANT_INTERVAL_MS,
  runInviteGrantPullOnce,
  startInviteGrantPullLoop,
} = await import('../dist-electron/main/services/inviteGrantPullService.js');
const { MePointsApiError } = await import('../dist-electron/main/services/mePointsService.js');

const TENANT_ID = 't_invite_grant_test';
const SECRET = 'gateway-secret-invite-grant';
const TICKET = 'igt_test_secret_ticket_123';

function startFakeControlPlane(initialPending) {
  const state = {
    pending: initialPending ? { ...initialPending } : { pending: false },
    acks: [],
    pendingCalls: 0,
    rejectAuth: false,
    failAcks: 0,
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

      if (req.method === 'GET' && url.pathname === '/api/v1/tenant/invite-grant/pending') {
        state.pendingCalls += 1;
        return send(200, state.pending);
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/tenant/invite-grant/claimed') {
        if (state.failAcks > 0) {
          state.failAcks -= 1;
          return send(500, { error: { code: 'INTERNAL' } });
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        state.acks.push(body);
        if (body.ok === true) {
          state.pending = { pending: false };
        }
        return send(200, { ok: true });
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

function envFor(controlPlaneUrl, extra = {}) {
  return {
    IDBOTS_CONTROL_PLANE_URL: controlPlaneUrl,
    IDBOTS_TENANT_ID: TENANT_ID,
    IDBOTS_GATEWAY_SECRET: SECRET,
    ...extra,
  };
}

function quietLogger() {
  const lines = [];
  const log = (level, msg, extra) => lines.push(JSON.stringify({ level, msg, extra }));
  return { lines, log };
}

test('inviteGrantPull: skips cleanly when control plane and bootstrap env are absent', async () => {
  let called = 0;
  const res = await runInviteGrantPullOnce({
    env: {},
    claimGrant: async () => {
      called += 1;
      throw new Error('must not claim');
    },
    log: quietLogger().log,
  });
  assert.equal(res.status, 'skipped');
  assert.equal(called, 0);
});

test('inviteGrantPull: claims pending ticket, posts claimed ack with periodEnd, and stops loop', async () => {
  const periodEndSec = 1_800_000_000;
  const cp = await startFakeControlPlane({
    pending: true,
    code: 'IDB-7K9M-X4',
    grantTicket: TICKET,
    planId: 'me_pro',
    periodDays: 14,
  });
  const claimedTickets = [];
  const logger = quietLogger();
  const loop = startInviteGrantPullLoop({
    env: envFor(cp.url),
    claimGrant: async (ticket) => {
      claimedTickets.push(ticket);
      return {
        applied: true,
        redemptionId: 'ird_1',
        planId: 'me_pro',
        periodDays: 14,
        subscription: { statusText: 'active', raw: { status: 'active', periodEnd: periodEndSec } },
      };
    },
    log: logger.log,
    initialDelayMs: 60_000,
    intervalMs: INVITE_GRANT_INTERVAL_MS,
  });
  try {
    const first = await loop.runNow();
    assert.equal(first.status, 'claimed');
    assert.equal(first.planId, 'me_pro');
    assert.equal(first.periodEnd, periodEndSec * 1000);
    assert.deepEqual(claimedTickets, [TICKET]);
    assert.equal(cp.state.acks.length, 1);
    assert.deepEqual(cp.state.acks[0], {
      ok: true,
      planId: 'me_pro',
      periodEnd: periodEndSec * 1000,
    });

    const second = await loop.runNow();
    assert.equal(second.status, 'none');
    assert.equal(claimedTickets.length, 1, 'settled loop must not re-claim');
    assert.ok(logger.lines.every((l) => !l.includes(TICKET)), 'secret grant ticket must never be logged');
  } finally {
    loop.stop();
    await cp.close();
  }
});

test('inviteGrantPull: identity_not_ready retries without burning backoff; upstream failure reports ok:false', async () => {
  const cp = await startFakeControlPlane({
    pending: true,
    grantTicket: TICKET,
    planId: 'me_pro',
    periodDays: 14,
  });
  let phase = 'missing_identity';
  try {
    const first = await runInviteGrantPullOnce({
      env: envFor(cp.url),
      claimGrant: async () => {
        if (phase === 'missing_identity') {
          throw new MePointsApiError({
            stage: 'invite_claim',
            errorCode: 'NO_IDENTITY',
            message: 'local user identity is missing or incomplete',
          });
        }
        if (phase === 'upstream_down') {
          throw new MePointsApiError({
            stage: 'invite_claim',
            errorCode: 'UPSTREAM_503',
            message: 'ABS 503',
            status: 503,
          });
        }
        return {
          applied: true,
          planId: 'me_pro',
          periodDays: 14,
          subscription: { statusText: 'active', raw: { periodEnd: 1_800_000_000_000 } },
        };
      },
      log: quietLogger().log,
    });
    assert.equal(first.status, 'retry');
    assert.equal(first.reason, 'identity_not_ready');
    assert.equal(cp.state.acks.length, 0);

    phase = 'upstream_down';
    const second = await runInviteGrantPullOnce({
      env: envFor(cp.url),
      claimGrant: async () => {
        throw new MePointsApiError({
          stage: 'invite_claim',
          errorCode: 'UPSTREAM_503',
          message: 'ABS 503',
          status: 503,
        });
      },
      log: quietLogger().log,
    });
    assert.equal(second.status, 'retry');
    assert.equal(cp.state.acks.length, 1);
    assert.equal(cp.state.acks[0].ok, false);

    phase = 'ready';
    const third = await runInviteGrantPullOnce({
      env: envFor(cp.url, { [BOOTSTRAP_INVITE_GRANT_TICKET_ENV]: TICKET }),
      claimGrant: async () => ({
        applied: false,
        planId: 'me_pro',
        periodDays: 14,
        subscription: { statusText: 'active', raw: { periodEnd: 1_800_000_000_000 } },
      }),
      log: quietLogger().log,
    });
    assert.equal(third.status, 'claimed');
  } finally {
    await cp.close();
  }
});
