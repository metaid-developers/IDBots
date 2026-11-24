import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import type Database from 'better-sqlite3';
import { decryptSecret } from '../src/crypto.js';
import { HIBERNATED_PHASE, sweepExpiredTrialHibernation } from '../src/services/hibernation.js';
import { FakeDocker } from './fake-docker/index.mjs';
import {
  api,
  freshDb,
  MASTER_KEY,
  seedUserAndTenant,
  sessionCookieFrom,
  startTestApp,
  waitFor,
  type TestApp,
} from './helpers.js';

const PARTNER_TOKEN = 'abs-partner-secret-token';
const REPO_LEGAL_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../deploy/legal',
);

interface MockAbsState {
  dailyCapFull: boolean;
  codes: Map<
    string,
    {
      maxUses: number;
      usedCount: number;
      disabled?: boolean;
      planId: string;
      planName: string;
      planNameEn: string;
      periodDays: number;
    }
  >;
  consumeCalls: Array<{ code: string; cpUserId: string; cpTenantId: string; phoneMasked: string }>;
  trialStatuses: Map<
    string,
    {
      redemptionStatus: number;
      subscriptionActive: boolean;
      planId: string;
      sourceType: string;
      periodEnd: number;
    }
  >;
}

function startMockAbsServer(state: MockAbsState): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};

      if (req.method === 'GET' && url.pathname.startsWith('/v1/me/invite/public/')) {
        const code = decodeURIComponent(url.pathname.slice('/v1/me/invite/public/'.length));
        const entry = state.codes.get(code);
        if (!entry || entry.disabled) {
          send(200, {
            code: 0,
            message: 'success',
            data: {
              valid: false,
              reasonCode: 'INVITE_INVALID_CODE',
              code,
              planId: 'me_pro',
              planName: 'ID.Student',
              planNameEn: 'ID.Student',
              periodDays: 14,
              dailyCapFull: state.dailyCapFull,
            },
          });
          return;
        }
        const exhausted = entry.usedCount >= entry.maxUses;
        send(200, {
          code: 0,
          message: 'success',
          data: {
            valid: !exhausted,
            ...(exhausted ? { reasonCode: 'INVITE_CODE_EXHAUSTED' } : {}),
            code,
            planId: entry.planId,
            planName: entry.planName,
            planNameEn: entry.planNameEn,
            periodDays: entry.periodDays,
            dailyCapFull: state.dailyCapFull,
          },
        });
        return;
      }

      if (req.headers.authorization !== `Bearer ${PARTNER_TOKEN}`) {
        send(401, { code: 40100, message: 'unauthorized' });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/me/invite/partner/precheck') {
        const code = String(parsed.code ?? '');
        const entry = state.codes.get(code);
        if (!entry || entry.disabled) {
          send(200, {
            code: 0,
            message: 'success',
            data: {
              allowed: false,
              reasonCode: 'INVITE_INVALID_CODE',
              code,
              planId: 'me_pro',
              planName: 'ID.Student',
              planNameEn: 'ID.Student',
              periodDays: 14,
              remainingToday: 50,
            },
          });
          return;
        }
        if (entry.usedCount >= entry.maxUses) {
          send(200, {
            code: 0,
            message: 'success',
            data: {
              allowed: false,
              reasonCode: 'INVITE_CODE_EXHAUSTED',
              code,
              planId: entry.planId,
              planName: entry.planName,
              planNameEn: entry.planNameEn,
              periodDays: entry.periodDays,
              remainingToday: 50,
            },
          });
          return;
        }
        if (state.dailyCapFull) {
          send(200, {
            code: 0,
            message: 'success',
            data: {
              allowed: false,
              reasonCode: 'INVITE_DAILY_CAP_FULL',
              code,
              planId: entry.planId,
              planName: entry.planName,
              planNameEn: entry.planNameEn,
              periodDays: entry.periodDays,
              remainingToday: 0,
            },
          });
          return;
        }
        send(200, {
          code: 0,
          message: 'success',
          data: {
            allowed: true,
            code,
            planId: entry.planId,
            planName: entry.planName,
            planNameEn: entry.planNameEn,
            periodDays: entry.periodDays,
            remainingToday: 49,
          },
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/me/invite/partner/consume') {
        const code = String(parsed.code ?? '');
        const cpUserId = String(parsed.cpUserId ?? '');
        const cpTenantId = String(parsed.cpTenantId ?? '');
        const phoneMasked = String(parsed.phoneMasked ?? '');
        const entry = state.codes.get(code);
        if (!entry || entry.disabled) {
          send(200, {
            code: 0,
            message: 'success',
            data: {
              allowed: false,
              reasonCode: 'INVITE_INVALID_CODE',
              code,
              planId: 'me_pro',
              planName: 'ID.Student',
              planNameEn: 'ID.Student',
              periodDays: 14,
            },
          });
          return;
        }
        if (state.dailyCapFull) {
          send(200, {
            code: 0,
            message: 'success',
            data: {
              allowed: false,
              reasonCode: 'INVITE_DAILY_CAP_FULL',
              code,
              planId: entry.planId,
              planName: entry.planName,
              planNameEn: entry.planNameEn,
              periodDays: entry.periodDays,
            },
          });
          return;
        }
        if (entry.usedCount >= entry.maxUses) {
          send(200, {
            code: 0,
            message: 'success',
            data: {
              allowed: false,
              reasonCode: 'INVITE_CODE_EXHAUSTED',
              code,
              planId: entry.planId,
              planName: entry.planName,
              planNameEn: entry.planNameEn,
              periodDays: entry.periodDays,
            },
          });
          return;
        }
        entry.usedCount += 1;
        state.consumeCalls.push({ code, cpUserId, cpTenantId, phoneMasked });
        send(200, {
          code: 0,
          message: 'success',
          data: {
            allowed: true,
            redemptionId: `red_${cpUserId}`,
            grantTicket: `igt_ticket_${cpUserId}`,
            code,
            planId: entry.planId,
            planName: entry.planName,
            planNameEn: entry.planNameEn,
            periodDays: entry.periodDays,
          },
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/me/invite/partner/tenant-trial-status') {
        const cpUserIds = Array.isArray(parsed.cpUserIds) ? (parsed.cpUserIds as string[]) : [];
        const items = cpUserIds
          .filter((id) => state.trialStatuses.has(id))
          .map((id) => ({ cpUserId: id, ...state.trialStatuses.get(id)! }));
        send(200, { code: 0, message: 'success', data: { items } });
        return;
      }

      send(404, { code: 40400, message: 'not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('ABS partner invite integration, tenant grant claim, hibernation & legal docs', () => {
  let db: Database.Database;
  let fake: FakeDocker;
  let absServer: { baseUrl: string; close: () => Promise<void> };
  let t: TestApp;
  const absState: MockAbsState = {
    dailyCapFull: false,
    codes: new Map([
      [
        'IDB-8K4M2P',
        {
          maxUses: 2,
          usedCount: 0,
          planId: 'me_pro',
          planName: 'ID.Student',
          planNameEn: 'ID.Student',
          periodDays: 14,
        },
      ],
      [
        'IDB-USED99',
        {
          maxUses: 1,
          usedCount: 1,
          planId: 'me_pro',
          planName: 'ID.Student',
          planNameEn: 'ID.Student',
          periodDays: 14,
        },
      ],
    ]),
    consumeCalls: [],
    trialStatuses: new Map(),
  };

  const DAY_MS = 24 * 60 * 60 * 1000;

  before(async () => {
    db = freshDb();
    fake = new FakeDocker();
    await fake.listen(0);
    absServer = await startMockAbsServer(absState);
    t = await startTestApp({
      db,
      dockerUrl: fake.url(),
      fakeSmsNumbers: ['+8613900008101', '+8613900008102', '+8613900008103'],
      legalDir: REPO_LEGAL_DIR,
      inviteService: {
        baseUrl: absServer.baseUrl,
        token: PARTNER_TOKEN,
        hibernateAfterMs: 7 * DAY_MS,
        wakeGraceMs: DAY_MS,
      },
    });
  });

  after(async () => {
    await t.close();
    await absServer.close();
    await fake.close();
    db.close();
  });

  test('GET /api/v1/auth/invite/preview normalizes code and returns ABS plan metadata', async () => {
    const okRes = await api(t.baseUrl, '/api/v1/auth/invite/preview?code=idb8k4m2p');
    assert.equal(okRes.status, 200);
    const body = okRes.json as Record<string, unknown>;
    assert.equal(body.valid, true);
    assert.equal(body.code, 'IDB-8K4M2P');
    assert.equal(body.planId, 'me_pro');
    assert.equal(body.planName, 'ID.Student');
    assert.equal(body.periodDays, 14);

    const badRes = await api(t.baseUrl, '/api/v1/auth/invite/preview?code=IDB-NOPE00');
    assert.equal(badRes.status, 200);
    assert.equal((badRes.json as Record<string, unknown>).valid, false);
  });

  test('sms/send prechecks invite & daily cap before sending SMS for unknown phones', async () => {
    const phone = '+8613900008101';

    const missing = await api(t.baseUrl, '/api/v1/auth/sms/send', {
      method: 'POST',
      body: { phone, purpose: 'login' },
    });
    assert.equal(missing.status, 403);
    assert.equal((missing.json as { error?: { code?: string } })?.error?.code, 'INVITE_REQUIRED');

    const invalid = await api(t.baseUrl, '/api/v1/auth/sms/send', {
      method: 'POST',
      body: { phone, purpose: 'login', inviteCode: 'IDB-WRONG1' },
    });
    assert.equal(invalid.status, 403);
    assert.equal((invalid.json as { error?: { code?: string } })?.error?.code, 'INVITE_INVALID');

    const exhausted = await api(t.baseUrl, '/api/v1/auth/sms/send', {
      method: 'POST',
      body: { phone, purpose: 'login', inviteCode: 'IDB-USED99' },
    });
    assert.equal(exhausted.status, 403);
    assert.equal((exhausted.json as { error?: { code?: string } })?.error?.code, 'INVITE_EXHAUSTED');

    absState.dailyCapFull = true;
    try {
      const capFull = await api(t.baseUrl, '/api/v1/auth/sms/send', {
        method: 'POST',
        body: { phone, purpose: 'login', inviteCode: 'IDB-8K4M2P' },
      });
      assert.equal(capFull.status, 429);
      assert.equal(
        (capFull.json as { error?: { code?: string } })?.error?.code,
        'INVITE_DAILY_CAP_FULL',
      );
    } finally {
      absState.dailyCapFull = false;
    }

    // Zero SMS rows were created during rejected prechecks, and code count is untouched.
    const smsCount = (
      db.prepare('SELECT COUNT(*) AS n FROM sms_codes WHERE phone_e164 = ?').get(phone) as {
        n: number;
      }
    ).n;
    assert.equal(smsCount, 0);
    assert.equal(absState.codes.get('IDB-8K4M2P')!.usedCount, 0);
  });

  test('sms/verify consumes partner invite, injects bootstrap ticket env, and supports tenant pull/ack', async () => {
    const phone = '+8613900008101';
    const sendRes = await api(t.baseUrl, '/api/v1/auth/sms/send', {
      method: 'POST',
      body: { phone, purpose: 'login', inviteCode: 'idb8k4m2p' },
    });
    assert.equal(sendRes.status, 200);

    const verifyRes = await api(t.baseUrl, '/api/v1/auth/sms/verify', {
      method: 'POST',
      body: { phone, code: '246810', inviteCode: 'idb8k4m2p' },
    });
    assert.equal(verifyRes.status, 200);
    const cookie = sessionCookieFrom(verifyRes.setCookie);

    assert.equal(absState.consumeCalls.length, 1);
    const consumed = absState.consumeCalls[0];
    assert.equal(consumed.code, 'IDB-8K4M2P');
    assert.equal(consumed.phoneMasked, '+861****8101');
    assert.ok(!consumed.phoneMasked.includes('00008101'));

    const grantRow = db
      .prepare('SELECT * FROM invite_grants WHERE user_id = ?')
      .get(consumed.cpUserId) as {
      tenant_id: string;
      grant_ticket_enc: string | null;
      claimed_at: number | null;
      plan_id: string;
      period_days: number;
    };
    assert.equal(grantRow.tenant_id, consumed.cpTenantId);
    assert.equal(grantRow.plan_id, 'me_pro');
    assert.equal(grantRow.period_days, 14);
    assert.equal(grantRow.claimed_at, null);
    assert.ok(grantRow.grant_ticket_enc);
    assert.ok(!grantRow.grant_ticket_enc!.includes('igt_ticket_'));
    const expectedTicket = `igt_ticket_${consumed.cpUserId}`;
    assert.equal(decryptSecret(MASTER_KEY, grantRow.grant_ticket_enc!), expectedTicket);

    // Wait for async container provisioning in FakeDocker and verify bootstrap env injection.
    const container = await waitFor(async () => {
      for (const c of fake.containers.values()) {
        if ((c as { name?: string }).name === `idb-${consumed.cpTenantId}`) {
          return c as { env?: Record<string, string> | string[] };
        }
      }
      return null;
    });
    const envVal = Array.isArray(container.env)
      ? container.env.find((e) => e.startsWith('IDBOTS_BOOTSTRAP_INVITE_GRANT_TICKET='))?.split('=')[1]
      : container.env?.IDBOTS_BOOTSTRAP_INVITE_GRANT_TICKET;
    assert.equal(envVal, expectedTicket);

    // Existing active user subsequent login needs NO inviteCode.
    db.prepare('DELETE FROM sms_codes WHERE phone_e164 = ?').run(phone);
    const existingSend = await api(t.baseUrl, '/api/v1/auth/sms/send', {
      method: 'POST',
      body: { phone, purpose: 'login' },
    });
    assert.equal(existingSend.status, 200);

    // Tenant grant pull/ack endpoints authenticate via gateway secret.
    const tenantRow = db
      .prepare('SELECT gateway_secret_enc FROM tenants WHERE id = ?')
      .get(consumed.cpTenantId) as { gateway_secret_enc: string };
    const gatewaySecret = decryptSecret(MASTER_KEY, tenantRow.gateway_secret_enc);

    const unauth = await fetch(`${t.baseUrl}/api/v1/tenant/invite-grant/pending`);
    assert.equal(unauth.status, 401);

    const pending1 = await fetch(`${t.baseUrl}/api/v1/tenant/invite-grant/pending`, {
      headers: {
        'x-tenant-id': consumed.cpTenantId,
        authorization: `Bearer ${gatewaySecret}`,
      },
    });
    assert.equal(pending1.status, 200);
    const pendingBody1 = (await pending1.json()) as Record<string, unknown>;
    assert.equal(pendingBody1.pending, true);
    assert.equal(pendingBody1.grantTicket, expectedTicket);

    // Report transient failure -> stays pending, increments attempts.
    const failAck = await fetch(`${t.baseUrl}/api/v1/tenant/invite-grant/claimed`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': consumed.cpTenantId,
        authorization: `Bearer ${gatewaySecret}`,
      },
      body: JSON.stringify({ ok: false, error: 'ABS timeout' }),
    });
    assert.equal(failAck.status, 200);
    assert.deepEqual(await failAck.json(), { claimed: false, claimAttempts: 1 });

    // Report success -> clears encrypted ticket, sets claimed_at & trial_ends_at.
    const claimedPeriodEnd = Date.now() + 14 * DAY_MS;
    const okAck = await fetch(`${t.baseUrl}/api/v1/tenant/invite-grant/claimed`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': consumed.cpTenantId,
        authorization: `Bearer ${gatewaySecret}`,
      },
      body: JSON.stringify({ ok: true, planId: 'me_pro', periodEnd: claimedPeriodEnd }),
    });
    assert.equal(okAck.status, 200);
    assert.equal(((await okAck.json()) as { claimed?: boolean }).claimed, true);

    const pending2 = await fetch(`${t.baseUrl}/api/v1/tenant/invite-grant/pending`, {
      headers: {
        'x-tenant-id': consumed.cpTenantId,
        authorization: `Bearer ${gatewaySecret}`,
      },
    });
    assert.deepEqual(await pending2.json(), {
      tenantId: consumed.cpTenantId,
      userId: consumed.cpUserId,
      pending: false,
    });

    // Legal routes serve 200 HTML even with a valid session cookie on a ready tenant.
    db.prepare("UPDATE tenants SET status = 'ready' WHERE id = ?").run(consumed.cpTenantId);
    for (const legalPath of ['/terms', '/privacy', '/custody', '/support', '/disclosure']) {
      const res = await fetch(`${t.baseUrl}${legalPath}`, {
        headers: { Cookie: cookie },
        redirect: 'manual',
      });
      assert.equal(res.status, 200, `expected 200 for ${legalPath}`);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
      const html = await res.text();
      if (legalPath === '/terms') {
        assert.match(html, /v2\.1/);
      }
    }
  });

  test('hibernates >7d expired unsubscribed trial containers, spares paid users, and auto-wakes on login/me', async () => {
    const now = Date.now();
    const expiredEightDaysAgo = now - 8 * DAY_MS;

    // 1. Expired unsubscribed trial user + running container in FakeDocker
    seedUserAndTenant(db, {
      userId: 'u_hib_expired',
      phone: '+8613900008201',
      tenantId: 't_hib_expired',
      status: 'ready',
      gatewaySecret: 'sec-expired',
      inviteCode: 'IDB-8K4M2P',
    });
    const createdContainer = await t.app.docker.createContainer({
      name: 'idb-t_hib_expired',
      image: 'fake-tenant:test',
      env: { IDBOTS_GATEWAY_SECRET: 'sec-expired' },
    });
    await t.app.docker.startContainer(createdContainer.Id);
    db.prepare(
      `INSERT INTO invite_grants (
         user_id, tenant_id, code, plan_id, period_days, trial_ends_at, claimed_at, created_at, updated_at
       ) VALUES ('u_hib_expired', 't_hib_expired', 'IDB-8K4M2P', 'me_pro', 14, ?, ?, ?, ?)`,
    ).run(expiredEightDaysAgo, expiredEightDaysAgo - 14 * DAY_MS, now, now);
    absState.trialStatuses.set('u_hib_expired', {
      redemptionStatus: 2,
      subscriptionActive: false,
      planId: 'me_pro',
      sourceType: 'invite_trial',
      periodEnd: expiredEightDaysAgo,
    });

    // 2. Paid upgraded user whose original trial_ends_at was 8d ago -> must NOT hibernate
    seedUserAndTenant(db, {
      userId: 'u_hib_paid',
      phone: '+8613900008202',
      tenantId: 't_hib_paid',
      status: 'ready',
      gatewaySecret: 'sec-paid',
      inviteCode: 'IDB-8K4M2P',
    });
    const paidFutureEnd = now + 25 * DAY_MS;
    db.prepare(
      `INSERT INTO invite_grants (
         user_id, tenant_id, code, plan_id, period_days, trial_ends_at, claimed_at, created_at, updated_at
       ) VALUES ('u_hib_paid', 't_hib_paid', 'IDB-8K4M2P', 'me_pro', 14, ?, ?, ?, ?)`,
    ).run(expiredEightDaysAgo, expiredEightDaysAgo - 14 * DAY_MS, now, now);
    absState.trialStatuses.set('u_hib_paid', {
      redemptionStatus: 2,
      subscriptionActive: true,
      planId: 'me_standard',
      sourceType: 'paid_order',
      periodEnd: paidFutureEnd,
    });

    // 3. Admin-stopped tenant (no hibernated_at) -> must NEVER auto-wake
    seedUserAndTenant(db, {
      userId: 'u_admin_stopped',
      phone: '+8613900008203',
      tenantId: 't_admin_stopped',
      status: 'stopped',
      gatewaySecret: 'sec-admin-stop',
    });

    const hibernated = await sweepExpiredTrialHibernation(t.app, now);
    assert.equal(hibernated, 1);

    const expiredTenant = db
      .prepare('SELECT status, phase FROM tenants WHERE id = ?')
      .get('t_hib_expired') as { status: string; phase: string | null };
    assert.equal(expiredTenant.status, 'stopped');
    assert.equal(expiredTenant.phase, HIBERNATED_PHASE);
    const inspectedStopped = await t.app.docker.inspectContainer(createdContainer.Id);
    assert.equal(inspectedStopped.State.Running, false);

    const paidTenant = db
      .prepare('SELECT status FROM tenants WHERE id = ?')
      .get('t_hib_paid') as { status: string };
    assert.equal(paidTenant.status, 'ready');
    const paidGrant = db
      .prepare('SELECT trial_ends_at FROM invite_grants WHERE user_id = ?')
      .get('u_hib_paid') as { trial_ends_at: number };
    assert.equal(paidGrant.trial_ends_at, paidFutureEnd);

    // Mint sessions for u_hib_expired and u_admin_stopped to test GET /api/v1/me behavior.
    const { sha256Hex } = await import('../src/crypto.js');
    db.prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent, ip)
       VALUES (?, 'u_hib_expired', ?, ?, ?, 'test', '127.0.0.1')`,
    ).run(sha256Hex('tok_expired'), now, now, now + DAY_MS);
    db.prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent, ip)
       VALUES (?, 'u_admin_stopped', ?, ?, ?, 'test', '127.0.0.1')`,
    ).run(sha256Hex('tok_admin_stop'), now, now, now + DAY_MS);

    // Calling GET /api/v1/me on hibernated trial user flips status -> booting and restarts container!
    const meWake = await api(t.baseUrl, '/api/v1/me', {
      cookie: 'idb_session=tok_expired',
    });
    assert.equal(meWake.status, 200);
    assert.equal(
      (meWake.json as { tenant?: { status?: string } })?.tenant?.status,
      'booting',
    );
    await waitFor(async () => {
      const inspect = await t.app.docker.inspectContainer(createdContainer.Id);
      return inspect.State.Running ? true : null;
    });

    // Within 24h wakeGraceMs, even if tenant turns ready again, sweep does not re-hibernate.
    db.prepare("UPDATE tenants SET status = 'ready' WHERE id = 't_hib_expired'").run();
    const reSweepWithinGrace = await sweepExpiredTrialHibernation(t.app, now + 60 * 60 * 1000);
    assert.equal(reSweepWithinGrace, 0);

    // Admin-stopped tenant stays stopped on GET /api/v1/me.
    const meAdminStop = await api(t.baseUrl, '/api/v1/me', {
      cookie: 'idb_session=tok_admin_stop',
    });
    assert.equal(meAdminStop.status, 200);
    assert.equal(
      (meAdminStop.json as { tenant?: { status?: string } })?.tenant?.status,
      'stopped',
    );
  });
});
