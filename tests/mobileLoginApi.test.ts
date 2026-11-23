import test from 'node:test';
import assert from 'node:assert/strict';
import { getMe, logout, previewInvite, requestAccountDeletion, sendCode, verifyCode } from '../src/mobile/login/loginApi';

// Distinct phones per scenario keep the mock's "new vs returning phone"
// state deterministic (node:test runs a file's tests sequentially).
const PHONE = '+8613800000000';
const PHONE_INVITE_REQUIRED = '+8613900000001';
const PHONE_INVITE_OK = '+8613900000002';
const PHONE_INVITE_BAD = '+8613900000003';
const PHONE_INVITE_FULL = '+8613900000004';
const PHONE_CODE_EXPIRED = '+8613900000005';
const PHONE_DISPLAY_NAME = '+8613900000006';

test('loginApi.sendCode returns the C3 resendAfterSec shape', async () => {
  const result = await sendCode(PHONE);
  assert.deepEqual(result, { resendAfterSec: 60 });
});

test('loginApi.sendCode rejects invalid phone numbers with INVALID_PHONE', async () => {
  await assert.rejects(sendCode('123'), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'INVALID_PHONE');
    return true;
  });
});

test('loginApi.sendCode accepts the purpose parameter (staging 400s without it)', async () => {
  const result = await sendCode(PHONE, 'login');
  assert.deepEqual(result, { resendAfterSec: 60 });
});

test('loginApi.getMe rejects without an active session', async () => {
  await assert.rejects(getMe(), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'UNAUTHORIZED');
    return true;
  });
});

test('loginApi.verifyCode returns C3 user and tenant objects (new phone with invite)', async () => {
  const result = await verifyCode(PHONE, '123456', { inviteCode: 'invite-token' });
  assert.equal(result.user.id, 'mock-user');
  assert.ok(result.user.phoneMasked.includes('****'));
  assert.ok(!result.user.phoneMasked.includes(PHONE.slice(3, 11)));
  assert.equal(result.tenant.status, 'provisioning');
  assert.equal(result.tenant.error, null);
});

test('loginApi.verifyCode rejects an empty code with CODE_INVALID', async () => {
  await assert.rejects(verifyCode(PHONE, ''), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'CODE_INVALID');
    return true;
  });
});

test('loginApi.verifyCode requires an invite for a new phone (INVITE_REQUIRED)', async () => {
  await assert.rejects(
    verifyCode(PHONE_INVITE_REQUIRED, '123456'),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'INVITE_REQUIRED');
      return true;
    },
  );
});

test('loginApi.verifyCode accepts a valid invite for a new phone', async () => {
  const result = await verifyCode(PHONE_INVITE_OK, '123456', { inviteCode: 'invite-token' });
  assert.equal(result.tenant.status, 'provisioning');
});

test('loginApi.verifyCode rejects the BAD invite fixture with INVITE_INVALID', async () => {
  await assert.rejects(
    verifyCode(PHONE_INVITE_BAD, '123456', { inviteCode: 'BAD' }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'INVITE_INVALID');
      return true;
    },
  );
});

test('loginApi.verifyCode rejects the FULL invite fixture with INVITE_EXHAUSTED', async () => {
  await assert.rejects(
    verifyCode(PHONE_INVITE_FULL, '123456', { inviteCode: 'FULL' }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'INVITE_EXHAUSTED');
      return true;
    },
  );
});

test('loginApi.verifyCode rejects the expired-code fixture with CODE_EXPIRED', async () => {
  await assert.rejects(
    verifyCode(PHONE_CODE_EXPIRED, '000000'),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'CODE_EXPIRED');
      return true;
    },
  );
});

test('loginApi.verifyCode accepts a displayName option at sign-up', async () => {
  const result = await verifyCode(PHONE_DISPLAY_NAME, '123456', {
    inviteCode: 'invite-token',
    displayName: 'OnChain Name',
  });
  assert.equal(result.user.id, 'mock-user');
});

test('loginApi.verifyCode needs no invite for a returning phone', async () => {
  const result = await verifyCode(PHONE, '654321');
  assert.equal(result.tenant.status, 'provisioning');
});

test('loginApi.getMe advances the tenant provisioning -> booting -> onboarding -> ready', async () => {
  await verifyCode(PHONE_INVITE_OK, '789012', { inviteCode: 'invite-token' });
  const statuses: string[] = [];
  for (let call = 0; call < 9; call += 1) {
    const me = await getMe();
    statuses.push(me.tenant.status);
  }
  assert.deepEqual(statuses.slice(0, 2), ['provisioning', 'provisioning']);
  assert.deepEqual(statuses.slice(2, 4), ['booting', 'booting']);
  assert.deepEqual(statuses.slice(4, 6), ['onboarding', 'onboarding']);
  assert.deepEqual(statuses.slice(6), ['ready', 'ready', 'ready']);
});

test('loginApi.getMe exposes a phase while booting or onboarding', async () => {
  await verifyCode(PHONE_INVITE_OK, '345678');
  await getMe();
  await getMe();
  const booting = await getMe();
  assert.equal(booting.tenant.status, 'booting');
  assert.equal(booting.tenant.phase, 'starting-services');
});

test('loginApi.logout succeeds and resets the tenant progression', async () => {
  await verifyCode(PHONE_INVITE_OK, '901234'); // returning phone; tenant restarts at provisioning
  for (let call = 0; call < 8; call += 1) {
    await getMe(); // drive the tenant to `ready`
  }
  assert.equal((await getMe()).tenant.status, 'ready');
  assert.deepEqual(await logout(), { success: true });
  await verifyCode(PHONE_INVITE_OK, '567890');
  assert.equal((await getMe()).tenant.status, 'provisioning');
});

test('loginApi logs never contain the phone number, SMS code, or invite code (SEC-12)', async () => {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await sendCode(PHONE);
    await verifyCode(PHONE, '123456', { inviteCode: 'invite-token', displayName: 'Secret Name' });
    await getMe();
    await logout();
  } finally {
    console.info = original;
  }
  const all = lines.join('\n');
  assert.ok(all.includes('[loginApi] sendCode'));
  assert.ok(all.includes('[loginApi] verifyCode'));
  assert.ok(!all.includes(PHONE), 'phone number must not be logged');
  assert.ok(!all.includes('13800000000'), 'phone digits must not be logged');
  assert.ok(!all.includes('123456'), 'SMS code must not be logged');
  assert.ok(!all.includes('invite-token'), 'invite code must not be logged');
  assert.ok(!all.includes('Secret Name'), 'display name value must not be logged');
});

test('loginApi.requestAccountDeletion rejects without a session and clears it after', async () => {
  await assert.rejects(requestAccountDeletion('done with the demo'), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'UNAUTHORIZED');
    return true;
  });
  await verifyCode('+8613900000111', '246810', { inviteCode: 'invite-token' });
  const result = await requestAccountDeletion('done with the demo');
  assert.deepEqual(result, { success: true });
  // The session is gone: getMe rejects and a re-request fails too.
  await assert.rejects(getMe(), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'UNAUTHORIZED');
    return true;
  });
  await assert.rejects(requestAccountDeletion());
});

test('loginApi.previewInvite returns public grant metadata and daily cap fixtures', async () => {
  const valid = await previewInvite('IDB-7K9M-X4');
  assert.equal(valid.valid, true);
  assert.equal(valid.planId, 'me_pro');
  assert.equal(valid.periodDays, 14);
  assert.equal(valid.dailyCapFull, false);

  const bad = await previewInvite('BAD');
  assert.equal(bad.valid, false);
  assert.equal(bad.reasonCode, 'INVITE_INVALID_CODE');

  const cap = await previewInvite('CAPFULL');
  assert.equal(cap.valid, false);
  assert.equal(cap.dailyCapFull, true);
  assert.equal(cap.reasonCode, 'INVITE_DAILY_CAP_FULL');
});

test('loginApi.sendCode prechecks optional inviteCode before dispatching SMS', async () => {
  await assert.rejects(
    sendCode('+8613900000222', 'login', { inviteCode: 'CAPFULL' }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'INVITE_DAILY_CAP_FULL');
      return true;
    },
  );
  const ok = await sendCode('+8613900000222', 'login', { inviteCode: 'IDB-7K9M-X4' });
  assert.deepEqual(ok, { resendAfterSec: 60 });
});
