import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type Database from 'better-sqlite3';
import { dayStartMs } from '../src/services/asr/usage.js';
import { countSignupsToday, isDailySignupCapReached, signup } from '../src/services/signup.js';
import { hashSmsCode, type SmsProvider } from '../src/sms.js';
import { FakeDocker } from './fake-docker/index.mjs';
import {
  api,
  freshDb,
  insertInvite,
  MASTER_KEY,
  startTestApp,
  TENANT_DEFAULTS,
  type TestApp,
} from './helpers.js';

const NOW = Date.UTC(2026, 10, 26, 4, 0, 0); // 2026-11-26 12:00:00 Asia/Shanghai

describe('CP_DAILY_SIGNUP_CAP unit logic (Asia/Shanghai day boundary)', () => {
  test('counts only users created in the current Asia/Shanghai calendar day', () => {
    const db = freshDb();
    insertInvite(db, { code: 'CAP-UNIT', maxUses: 10, now: NOW - 86_400_000 });

    const todayStart = dayStartMs(NOW);
    // Created 1 ms before Asia/Shanghai midnight -> belongs to yesterday.
    const yest = signup(db, {
      phone: '+8613900002001',
      inviteCode: 'CAP-UNIT',
      now: todayStart - 1,
      tenantDefaults: TENANT_DEFAULTS,
      masterKey: MASTER_KEY,
      dailySignupCap: 1,
    });
    assert.equal(yest.ok, true);
    assert.equal(countSignupsToday(db, NOW), 0);
    assert.equal(isDailySignupCapReached(db, 1, NOW), false);

    // Created at today's Asia/Shanghai midnight -> fills cap=1 for today.
    const todayUser = signup(db, {
      phone: '+8613900002002',
      inviteCode: 'CAP-UNIT',
      now: todayStart,
      tenantDefaults: TENANT_DEFAULTS,
      masterKey: MASTER_KEY,
      dailySignupCap: 1,
    });
    assert.equal(todayUser.ok, true);
    assert.equal(countSignupsToday(db, NOW), 1);
    assert.equal(isDailySignupCapReached(db, 1, NOW), true);

    // Next new user today is rejected with INVITE_DAILY_CAP_FULL without spending an invite.
    const blocked = signup(db, {
      phone: '+8613900002003',
      inviteCode: 'CAP-UNIT',
      now: NOW,
      tenantDefaults: TENANT_DEFAULTS,
      masterKey: MASTER_KEY,
      dailySignupCap: 1,
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.code, 'INVITE_DAILY_CAP_FULL');
    }

    const invite = db.prepare('SELECT used_count FROM invites WHERE code = ?').get('CAP-UNIT') as {
      used_count: number;
    };
    assert.equal(invite.used_count, 2);

    // Existing user still signs in cleanly when today's cap is full.
    const existingLogin = signup(db, {
      phone: '+8613900002002',
      now: NOW,
      tenantDefaults: TENANT_DEFAULTS,
      masterKey: MASTER_KEY,
      dailySignupCap: 1,
    });
    assert.equal(existingLogin.ok, true);
    if (existingLogin.ok) {
      assert.equal(existingLogin.isNewUser, false);
    }

    db.close();
  });

  test('cap=0 blocks all new sign-ups while concurrent races never exceed cap', async () => {
    const db = freshDb();
    insertInvite(db, { code: 'CAP-RACE', maxUses: 10, now: NOW });

    const zeroBlocked = signup(db, {
      phone: '+8613900002010',
      inviteCode: 'CAP-RACE',
      now: NOW,
      tenantDefaults: TENANT_DEFAULTS,
      masterKey: MASTER_KEY,
      dailySignupCap: 0,
    });
    assert.equal(zeroBlocked.ok, false);
    if (!zeroBlocked.ok) assert.equal(zeroBlocked.code, 'INVITE_DAILY_CAP_FULL');

    const phones = ['+8613900002011', '+8613900002012', '+8613900002013', '+8613900002014'];
    const results = await Promise.all(
      phones.map((phone) =>
        Promise.resolve().then(() =>
          signup(db, {
            phone,
            inviteCode: 'CAP-RACE',
            now: NOW,
            tenantDefaults: TENANT_DEFAULTS,
            masterKey: MASTER_KEY,
            dailySignupCap: 2,
          }),
        ),
      ),
    );
    assert.equal(results.filter((r) => r.ok).length, 2);
    assert.equal(
      results.filter((r) => !r.ok && r.code === 'INVITE_DAILY_CAP_FULL').length,
      phones.length - 2,
    );
    assert.equal(countSignupsToday(db, NOW), 2);
    db.close();
  });
});

describe('CP_DAILY_SIGNUP_CAP HTTP auth enforcement', () => {
  let db: Database.Database;
  let fake: FakeDocker;
  let app: TestApp;
  const sentPhones: string[] = [];

  const spySmsProvider: SmsProvider = {
    mode: 'fake',
    async send(phone: string) {
      sentPhones.push(phone);
    },
  };

  before(async () => {
    db = freshDb();
    fake = new FakeDocker();
    await fake.listen(0);
    app = await startTestApp({
      db,
      dockerUrl: fake.url(),
      dailySignupCap: 2,
      fakeSmsNumbers: [
        '+8613900003001',
        '+8613900003002',
        '+8613900003003',
        '+8613900003004',
      ],
      smsProvider: spySmsProvider,
    });
  });

  after(async () => {
    await app.close();
    await fake.close();
    db.close();
  });

  test('allows up to daily cap, then blocks preview/send/verify for new users with 429 INVITE_DAILY_CAP_FULL without sending SMS or consuming invite', async () => {
    insertInvite(db, { code: 'OPEN-10', maxUses: 20, now: Date.now() });

    const beforeCap = await api(app.baseUrl, '/api/v1/auth/invite/preview?code=OPEN-10');
    assert.equal(beforeCap.status, 200);
    assert.equal((beforeCap.json as { valid: boolean; dailyCapFull: boolean }).valid, true);
    assert.equal((beforeCap.json as { dailyCapFull: boolean }).dailyCapFull, false);

    // Pre-issue an SMS code for user #3 BEFORE cap fills to verify sms/verify race protection too.
    const phone3 = '+8613900003003';
    const send3Early = await api(app.baseUrl, '/api/v1/auth/sms/send', {
      method: 'POST',
      body: { phone: phone3, purpose: 'login', inviteCode: 'OPEN-10' },
    });
    assert.equal(send3Early.status, 200);

    // Sign up users #1 and #2 -> fills cap = 2.
    for (const phone of ['+8613900003001', '+8613900003002']) {
      const sendRes = await api(app.baseUrl, '/api/v1/auth/sms/send', {
        method: 'POST',
        body: { phone, purpose: 'login', inviteCode: 'OPEN-10' },
      });
      assert.equal(sendRes.status, 200);
      const verifyRes = await api(app.baseUrl, '/api/v1/auth/sms/verify', {
        method: 'POST',
        body: { phone, code: '246810', inviteCode: 'OPEN-10' },
      });
      assert.equal(verifyRes.status, 200);
    }

    // Preview now reports dailyCapFull: true while invite stays valid.
    const afterCap = await api(app.baseUrl, '/api/v1/auth/invite/preview?code=OPEN-10');
    assert.equal(afterCap.status, 200);
    assert.equal((afterCap.json as { valid: boolean; dailyCapFull: boolean }).valid, true);
    assert.equal((afterCap.json as { dailyCapFull: boolean }).dailyCapFull, true);

    // User #4 calling sms/send gets 429 INVITE_DAILY_CAP_FULL and triggers NO SMS send.
    const smsCountBefore = sentPhones.length;
    const phone4 = '+8613900003004';
    const blockedSend = await api(app.baseUrl, '/api/v1/auth/sms/send', {
      method: 'POST',
      body: { phone: phone4, purpose: 'login', inviteCode: 'OPEN-10' },
    });
    assert.equal(blockedSend.status, 429);
    assert.equal((blockedSend.json as { error: { code: string } }).error.code, 'INVITE_DAILY_CAP_FULL');
    assert.equal(sentPhones.length, smsCountBefore);

    // User #3 (who got a code before cap filled) calling sms/verify gets 429 INVITE_DAILY_CAP_FULL,
    // without consuming the invite seat or consuming their SMS code.
    const blockedVerify = await api(app.baseUrl, '/api/v1/auth/sms/verify', {
      method: 'POST',
      body: { phone: phone3, code: '246810', inviteCode: 'OPEN-10' },
    });
    assert.equal(blockedVerify.status, 429);
    assert.equal((blockedVerify.json as { error: { code: string } }).error.code, 'INVITE_DAILY_CAP_FULL');

    const invite = db.prepare('SELECT used_count FROM invites WHERE code = ?').get('OPEN-10') as {
      used_count: number;
    };
    assert.equal(invite.used_count, 2);

    const smsRow = db.prepare('SELECT consumed_at FROM sms_codes WHERE phone_e164 = ?').get(phone3) as {
      consumed_at: number | null;
    };
    assert.equal(smsRow.consumed_at, null);

    // Existing user #1 can still request SMS and log in while cap is full.
    const existingPhone = '+8613900003001';
    db.prepare('DELETE FROM sms_codes WHERE phone_e164 = ?').run(existingPhone);
    const existingSend = await api(app.baseUrl, '/api/v1/auth/sms/send', {
      method: 'POST',
      body: { phone: existingPhone, purpose: 'login' },
    });
    assert.equal(existingSend.status, 200);
    db.prepare(
      `UPDATE sms_codes SET code_hash = ? WHERE phone_e164 = ?`,
    ).run(hashSmsCode(existingPhone, 'login', '246810'), existingPhone);
    const existingVerify = await api(app.baseUrl, '/api/v1/auth/sms/verify', {
      method: 'POST',
      body: { phone: existingPhone, code: '246810' },
    });
    assert.equal(existingVerify.status, 200);
  });
});
