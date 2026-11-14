import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { FakeDocker } from './fake-docker/index.mjs';
import {
  api,
  freshDb,
  insertInvite,
  sessionCookieFrom,
  startTestApp,
  type TestApp,
} from './helpers.js';
import { hashSmsCode } from '../src/sms.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let fake: FakeDocker;
let app: TestApp;

interface ErrorBody {
  error: { code: string; message: string };
}

interface VerifyBody {
  user: { id: string; phoneMasked: string; createdAt: number; locale: string };
  tenant: {
    status: string;
    phase: string | null;
    appVersion: string | null;
    contractVersion: string | null;
    error: string | null;
  };
}

const LISTED = '+8613900000100';
const ORIGIN: string | null | undefined = undefined; // api() default: the app origin

function insertLoginCode(phone: string, code = '246810', expiresInMs = 300_000): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sms_codes (phone_e164, purpose, code_hash, attempts, expires_at, consumed_at, ip, created_at)
     VALUES (?, 'login', ?, 0, ?, NULL, '127.0.0.1', ?)`,
  ).run(phone, hashSmsCode(phone, 'login', code), now + expiresInMs, now);
}

async function signupViaApi(phone: string, inviteCode: string): Promise<{ cookie: string; json: VerifyBody }> {
  const send = await api(app.baseUrl, '/api/v1/auth/sms/send', {
    method: 'POST',
    body: { phone, purpose: 'login' },
    origin: ORIGIN,
  });
  assert.equal(send.status, 200);
  const verify = await api(app.baseUrl, '/api/v1/auth/sms/verify', {
    method: 'POST',
    body: { phone, code: '246810', inviteCode },
    origin: ORIGIN,
  });
  assert.equal(verify.status, 200);
  return { cookie: sessionCookieFrom(verify.setCookie), json: verify.json };
}

before(async () => {
  db = freshDb();
  fake = new FakeDocker();
  await fake.listen(0);
  app = await startTestApp({
    db,
    dockerUrl: fake.url(),
    fakeSmsNumbers: [
      LISTED,
      ...Array.from({ length: 11 }, (_, i) => `+86139000010${String(i + 1).padStart(2, '0')}`),
    ],
  });
});

after(async () => {
  await app.close();
  await fake.close();
  db.close();
});

describe('C3 auth endpoints (AC-B-2 error matrix)', () => {
  test('INVALID_PHONE on a malformed number', async () => {
    const res = await api(app.baseUrl, '/api/v1/auth/sms/send', {
      method: 'POST',
      body: { phone: '12345', purpose: 'login' },
      origin: ORIGIN,
    });
    assert.equal(res.status, 400);
    assert.equal((res.json as ErrorBody).error.code, 'INVALID_PHONE');
  });

  test('send succeeds once, the 60 s rule returns 429 RATE_LIMITED', async () => {
    const phone = '+8613900001001';
    const first = await api(app.baseUrl, '/api/v1/auth/sms/send', {
      method: 'POST',
      body: { phone, purpose: 'login' },
      origin: ORIGIN,
    });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, { resendAfterSec: 60 });
    const second = await api(app.baseUrl, '/api/v1/auth/sms/send', {
      method: 'POST',
      body: { phone, purpose: 'login' },
      origin: ORIGIN,
    });
    assert.equal(second.status, 429);
    assert.equal((second.json as ErrorBody).error.code, 'RATE_LIMITED');
  });

  test('CODE_INVALID on a wrong code, and the attempt is counted', async () => {
    const phone = '+8613900001002';
    insertLoginCode(phone);
    const wrong = await api(app.baseUrl, '/api/v1/auth/sms/verify', {
      method: 'POST',
      body: { phone, code: '111111', inviteCode: 'X' },
      origin: ORIGIN,
    });
    assert.equal(wrong.status, 400);
    assert.equal((wrong.json as ErrorBody).error.code, 'CODE_INVALID');
    const attempts = (
      db
        .prepare('SELECT attempts FROM sms_codes WHERE phone_e164 = ? AND consumed_at IS NULL')
        .get(phone) as { attempts: number }
    ).attempts;
    assert.equal(attempts, 1);
  });

  test('TOO_MANY_ATTEMPTS once a code has 5 attempts', async () => {
    const phone = '+8613900001003';
    insertLoginCode(phone);
    db.prepare('UPDATE sms_codes SET attempts = 5 WHERE phone_e164 = ?').run(phone);
    const res = await api(app.baseUrl, '/api/v1/auth/sms/verify', {
      method: 'POST',
      body: { phone, code: '246810' },
      origin: ORIGIN,
    });
    assert.equal(res.status, 429);
    assert.equal((res.json as ErrorBody).error.code, 'TOO_MANY_ATTEMPTS');
  });

  test('CODE_EXPIRED for an expired code', async () => {
    const phone = '+8613900001004';
    insertLoginCode(phone, '246810', -1000);
    const res = await api(app.baseUrl, '/api/v1/auth/sms/verify', {
      method: 'POST',
      body: { phone, code: '246810' },
      origin: ORIGIN,
    });
    assert.equal(res.status, 400);
    assert.equal((res.json as ErrorBody).error.code, 'CODE_EXPIRED');
  });

  test('20 failed verifies lock the phone: verify 429 TOO_MANY_ATTEMPTS, send 429 RATE_LIMITED', async () => {
    const phone = '+8613900001005';
    const now = Date.now();
    for (let i = 0; i < 20; i += 1) {
      db.prepare(
        `INSERT INTO sms_codes (phone_e164, purpose, code_hash, attempts, expires_at, consumed_at, ip, created_at)
         VALUES (?, 'login', ?, 1, ?, NULL, '127.0.0.1', ?)`,
      ).run(phone, `lock-${phone}-${i}`, now + 300_000, now);
    }
    const verify = await api(app.baseUrl, '/api/v1/auth/sms/verify', {
      method: 'POST',
      body: { phone, code: '246810' },
      origin: ORIGIN,
    });
    assert.equal(verify.status, 429);
    assert.equal((verify.json as VerifyBody).error.code, 'TOO_MANY_ATTEMPTS');
    const send = await api(app.baseUrl, '/api/v1/auth/sms/send', {
      method: 'POST',
      body: { phone, purpose: 'login' },
      origin: ORIGIN,
    });
    assert.equal(send.status, 429);
    assert.equal((send.json as ErrorBody).error.code, 'RATE_LIMITED');
  });

  test('INVITE_REQUIRED, INVITE_INVALID, INVITE_EXHAUSTED for unknown phones', async () => {
    const phoneA = '+8613900001006';
    insertLoginCode(phoneA);
    const required = await api(app.baseUrl, '/api/v1/auth/sms/verify', {
      method: 'POST',
      body: { phone: phoneA, code: '246810' },
      origin: ORIGIN,
    });
    assert.equal(required.status, 403);
    assert.equal((required.json as ErrorBody).error.code, 'INVITE_REQUIRED');
    const codeAfterRequired = db.prepare('SELECT consumed_at FROM sms_codes WHERE phone_e164 = ?').get(phoneA) as { consumed_at: number | null };
    assert.equal(codeAfterRequired.consumed_at, null, 'an invite retry must not need a second SMS code');
    insertInvite(db, { code: 'RETRY-1', maxUses: 1, now: Date.now() });
    const retry = await api(app.baseUrl, '/api/v1/auth/sms/verify', {
      method: 'POST',
      body: { phone: phoneA, code: '246810', inviteCode: 'RETRY-1' },
      origin: ORIGIN,
    });
    assert.equal(retry.status, 200);
    const codeAfterRetry = db.prepare('SELECT consumed_at FROM sms_codes WHERE phone_e164 = ?').get(phoneA) as { consumed_at: number | null };
    assert.notEqual(codeAfterRetry.consumed_at, null);

    const phoneB = '+8613900001007';
    insertLoginCode(phoneB);
    const invalid = await api(app.baseUrl, '/api/v1/auth/sms/verify', {
      method: 'POST',
      body: { phone: phoneB, code: '246810', inviteCode: 'NOPE-1' },
      origin: ORIGIN,
    });
    assert.equal(invalid.status, 403);
    assert.equal((invalid.json as ErrorBody).error.code, 'INVITE_INVALID');
    const codeAfterInvalid = db.prepare('SELECT consumed_at FROM sms_codes WHERE phone_e164 = ?').get(phoneB) as { consumed_at: number | null };
    assert.equal(codeAfterInvalid.consumed_at, null);

    insertInvite(db, { code: 'GONE-1', maxUses: 1, usedCount: 1, now: Date.now() });
    const phoneC = '+8613900001008';
    insertLoginCode(phoneC);
    const exhausted = await api(app.baseUrl, '/api/v1/auth/sms/verify', {
      method: 'POST',
      body: { phone: phoneC, code: '246810', inviteCode: 'GONE-1' },
      origin: ORIGIN,
    });
    assert.equal(exhausted.status, 403);
    assert.equal((exhausted.json as ErrorBody).error.code, 'INVITE_EXHAUSTED');
    const codeAfterExhausted = db.prepare('SELECT consumed_at FROM sms_codes WHERE phone_e164 = ?').get(phoneC) as { consumed_at: number | null };
    assert.equal(codeAfterExhausted.consumed_at, null);
  });

  test('USER_DISABLED for a disabled account', async () => {
    const phone = '+8613900001009';
    insertInvite(db, { code: 'BAN-9', maxUses: 5, now: Date.now() });
    const { cookie } = await signupViaApi(phone, 'BAN-9');
    assert.ok(cookie.startsWith('idb_session='));
    const user = db.prepare('SELECT id FROM users WHERE phone_e164 = ?').get(phone) as { id: string };
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(user.id);
    db.prepare('DELETE FROM sms_codes WHERE phone_e164 = ?').run(phone);
    insertLoginCode(phone);
    const res = await api(app.baseUrl, '/api/v1/auth/sms/verify', {
      method: 'POST',
      body: { phone, code: '246810' },
      origin: ORIGIN,
    });
    assert.equal(res.status, 403);
    assert.equal((res.json as ErrorBody).error.code, 'USER_DISABLED');
  });

  test('ORIGIN_NOT_ALLOWED on state-changing requests without or with a wrong Origin', async () => {
    const missing = await api(app.baseUrl, '/api/v1/auth/sms/send', {
      method: 'POST',
      body: { phone: LISTED, purpose: 'login' },
      origin: null,
    });
    assert.equal(missing.status, 403);
    assert.equal((missing.json as ErrorBody).error.code, 'ORIGIN_NOT_ALLOWED');
    const wrong = await api(app.baseUrl, '/api/v1/auth/sms/send', {
      method: 'POST',
      body: { phone: LISTED, purpose: 'login' },
      origin: 'https://evil.example.com',
    });
    assert.equal(wrong.status, 403);
    assert.equal((wrong.json as ErrorBody).error.code, 'ORIGIN_NOT_ALLOWED');
  });

  test('GET /me without a cookie is 401 UNAUTHORIZED', async () => {
    const res = await api(app.baseUrl, '/api/v1/me');
    assert.equal(res.status, 401);
    assert.equal((res.json as ErrorBody).error.code, 'UNAUTHORIZED');
  });

  test('verify sets the C3 cookie attributes and masks the phone', async () => {
    const phone = '+8613900001010';
    insertInvite(db, { code: 'COOKIE-1', maxUses: 5, now: Date.now() });
    const send = await api(app.baseUrl, '/api/v1/auth/sms/send', {
      method: 'POST',
      body: { phone, purpose: 'login' },
      origin: ORIGIN,
    });
    assert.equal(send.status, 200);
    const verify = await api(app.baseUrl, '/api/v1/auth/sms/verify', {
      method: 'POST',
      body: { phone, code: '246810', inviteCode: 'COOKIE-1' },
      origin: ORIGIN,
    });
    assert.equal(verify.status, 200);
    const cookie = verify.setCookie.find((entry) => entry.startsWith('idb_session='));
    assert.ok(cookie);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=2592000/);
    assert.ok(verify.requestId, 'x-request-id header present');
    const body = verify.json as VerifyBody;
    assert.match(body.user.phoneMasked, /^\+861\*\*\*\*\d{4}$/);
    assert.equal(body.user.locale, 'zh');
  });

  test('logout clears the session: 204, clear-cookie, /me 401 afterwards', async () => {
    const phone = '+8613900001011';
    insertInvite(db, { code: 'OUT-1', maxUses: 5, now: Date.now() });
    const { cookie } = await signupViaApi(phone, 'OUT-1');

    const logout = await api(app.baseUrl, '/api/v1/auth/logout', { method: 'POST', origin: ORIGIN, cookie });
    assert.equal(logout.status, 204);
    const cleared = logout.setCookie.find((entry) => entry.startsWith('idb_session='));
    assert.ok(cleared);
    assert.match(cleared, /Max-Age=0/);

    const me = await api(app.baseUrl, '/api/v1/me', { cookie });
    assert.equal(me.status, 401);
  });
});
