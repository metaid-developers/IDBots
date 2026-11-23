import test from 'node:test';
import assert from 'node:assert/strict';
import { getMe, logout, previewInvite, requestAccountDeletion, sendCode, verifyCode } from '../src/mobile/login/loginApi';

/**
 * Real-C3-mode loginApi tests (no VITE_MOBILE_MOCK): every fetch is stubbed,
 * so these exercise the request shapes and the error-code mapping in
 * 01-interface-contracts.md — not the network. The mock-mode behaviour is
 * covered by tests/mobileLoginApi.test.ts under VITE_MOBILE_MOCK=1.
 *
 * Run with: npx tsx --test tests/mobileLoginApiReal.test.ts
 */

interface FetchCall {
  input: string;
  init: RequestInit | undefined;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Replaces globalThis.fetch with a recording stub for the duration of `run`
 * and restores it afterwards. `handler` maps a call to a Response.
 */
async function withStubbedFetch(
  handler: (call: FetchCall) => Response,
  run: (calls: FetchCall[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = { input: String(input), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const PHONE = '+8613800000000';
const TENANT_READY = {
  status: 'ready',
  phase: null,
  appVersion: '1.0.3',
  contractVersion: '1.0.0',
  error: null,
};

test('real sendCode POSTs phone and purpose to /api/v1/auth/sms/send', async () => {
  await withStubbedFetch(
    () => jsonResponse(200, { resendAfterSec: 60 }),
    async (calls) => {
      const result = await sendCode(PHONE);
      assert.deepEqual(result, { resendAfterSec: 60 });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].input, '/api/v1/auth/sms/send');
      assert.equal(calls[0].init?.method, 'POST');
      assert.equal(calls[0].init?.credentials, 'same-origin');
      assert.deepEqual(calls[0].init?.body, JSON.stringify({ phone: PHONE, purpose: 'login' }));
      assert.deepEqual(
        (calls[0].init?.headers as Record<string, string>)?.['Content-Type'],
        'application/json',
      );
    },
  );
});

test('real sendCode honours the purpose argument', async () => {
  await withStubbedFetch(
    () => jsonResponse(200, { resendAfterSec: 30 }),
    async (calls) => {
      await sendCode(PHONE, 'login');
      assert.deepEqual(calls[0].init?.body, JSON.stringify({ phone: PHONE, purpose: 'login' }));
    },
  );
});

test('real sendCode maps a 429 RATE_LIMITED body to error.code', async () => {
  await withStubbedFetch(
    () => jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'slow down' } }),
    async () => {
      await assert.rejects(sendCode(PHONE), (error: Error & { code?: string }) => {
        assert.equal(error.code, 'RATE_LIMITED');
        return true;
      });
    },
  );
});

test('real sendCode rejects a malformed phone locally without any fetch', async () => {
  await withStubbedFetch(
    () => jsonResponse(200, { resendAfterSec: 60 }),
    async (calls) => {
      await assert.rejects(sendCode('123'), (error: Error & { code?: string }) => {
        assert.equal(error.code, 'INVALID_PHONE');
        return true;
      });
      assert.equal(calls.length, 0);
    },
  );
});

test('real verifyCode POSTs phone/code/inviteCode/displayName to sms/verify', async () => {
  await withStubbedFetch(
    () => jsonResponse(200, { user: { id: 'u_1' }, tenant: TENANT_READY }),
    async (calls) => {
      const result = await verifyCode(PHONE, '246810', {
        inviteCode: 'INVITE-TOKEN',
        displayName: 'OnChain Name',
      });
      assert.equal(result.tenant.status, 'ready');
      assert.equal(calls[0].input, '/api/v1/auth/sms/verify');
      assert.equal(calls[0].init?.method, 'POST');
      assert.equal(calls[0].init?.credentials, 'same-origin');
      assert.deepEqual(
        calls[0].init?.body,
        JSON.stringify({
          phone: PHONE,
          code: '246810',
          inviteCode: 'INVITE-TOKEN',
          displayName: 'OnChain Name',
        }),
      );
    },
  );
});

test('real verifyCode omits absent invite/displayName keys from the body', async () => {
  await withStubbedFetch(
    () => jsonResponse(200, { user: { id: 'u_1' }, tenant: TENANT_READY }),
    async (calls) => {
      await verifyCode(PHONE, '246810');
      assert.deepEqual(calls[0].init?.body, JSON.stringify({ phone: PHONE, code: '246810' }));
    },
  );
});

test('real verifyCode passes INVITE_INVALID through as error.code', async () => {
  await withStubbedFetch(
    () => jsonResponse(403, { error: { code: 'INVITE_INVALID', message: 'bad invite' } }),
    async () => {
      await assert.rejects(
        verifyCode(PHONE, '246810', { inviteCode: 'BAD' }),
        (error: Error & { code?: string }) => {
          assert.equal(error.code, 'INVITE_INVALID');
          return true;
        },
      );
    },
  );
});

test('real verifyCode passes INVITE_EXHAUSTED through as error.code', async () => {
  await withStubbedFetch(
    () => jsonResponse(403, { error: { code: 'INVITE_EXHAUSTED', message: 'no uses left' } }),
    async () => {
      await assert.rejects(
        verifyCode(PHONE, '246810', { inviteCode: 'FULL' }),
        (error: Error & { code?: string }) => {
          assert.equal(error.code, 'INVITE_EXHAUSTED');
          return true;
        },
      );
    },
  );
});

test('real verifyCode passes INVITE_REQUIRED through as error.code', async () => {
  await withStubbedFetch(
    () => jsonResponse(403, { error: { code: 'INVITE_REQUIRED', message: 'invite needed' } }),
    async () => {
      await assert.rejects(
        verifyCode(PHONE, '246810'),
        (error: Error & { code?: string }) => {
          assert.equal(error.code, 'INVITE_REQUIRED');
          return true;
        },
      );
    },
  );
});

test('real verifyCode passes CODE_INVALID through as error.code', async () => {
  await withStubbedFetch(
    () => jsonResponse(400, { error: { code: 'CODE_INVALID', message: 'wrong code' } }),
    async () => {
      await assert.rejects(verifyCode(PHONE, '111111'), (error: Error & { code?: string }) => {
        assert.equal(error.code, 'CODE_INVALID');
        return true;
      });
    },
  );
});

test('real verifyCode passes TOO_MANY_ATTEMPTS through as error.code', async () => {
  await withStubbedFetch(
    () => jsonResponse(429, { error: { code: 'TOO_MANY_ATTEMPTS', message: 'locked' } }),
    async () => {
      await assert.rejects(verifyCode(PHONE, '111111'), (error: Error & { code?: string }) => {
        assert.equal(error.code, 'TOO_MANY_ATTEMPTS');
        return true;
      });
    },
  );
});

test('real verifyCode rejects an empty code locally without any fetch', async () => {
  await withStubbedFetch(
    () => jsonResponse(200, { user: { id: 'u_1' }, tenant: TENANT_READY }),
    async (calls) => {
      await assert.rejects(verifyCode(PHONE, ''), (error: Error & { code?: string }) => {
        assert.equal(error.code, 'CODE_INVALID');
        return true;
      });
      assert.equal(calls.length, 0);
    },
  );
});

test('real getMe GETs /api/v1/me and returns the user/tenant shape', async () => {
  await withStubbedFetch(
    () => jsonResponse(200, { user: { id: 'u_1' }, tenant: TENANT_READY }),
    async (calls) => {
      const result = await getMe();
      assert.equal(result.tenant.status, 'ready');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].input, '/api/v1/me');
      assert.equal(calls[0].init?.method, 'GET');
      assert.equal(calls[0].init?.credentials, 'same-origin');
      assert.equal(calls[0].init?.body, undefined);
    },
  );
});

test('real getMe maps a 401 JSON body to UNAUTHORIZED', async () => {
  await withStubbedFetch(
    () => jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'no session' } }),
    async () => {
      await assert.rejects(getMe(), (error: Error & { code?: string }) => {
        assert.equal(error.code, 'UNAUTHORIZED');
        return true;
      });
    },
  );
});

test('real getMe derives UNAUTHORIZED from a 401 with a non-JSON body', async () => {
  await withStubbedFetch(
    () => new Response('gateway timeout text', { status: 401 }),
    async () => {
      await assert.rejects(getMe(), (error: Error & { code?: string }) => {
        assert.equal(error.code, 'UNAUTHORIZED');
        return true;
      });
    },
  );
});

test('real getMe derives an HTTP_<status> code from an unlabelled error', async () => {
  await withStubbedFetch(
    () => new Response('nope', { status: 502 }),
    async () => {
      await assert.rejects(getMe(), (error: Error & { code?: string }) => {
        assert.equal(error.code, 'HTTP_502');
        return true;
      });
    },
  );
});

test('real logout POSTs /api/v1/auth/logout and succeeds on 204', async () => {
  await withStubbedFetch(
    () => new Response(null, { status: 204 }),
    async (calls) => {
      const result = await logout();
      assert.deepEqual(result, { success: true });
      assert.equal(calls[0].input, '/api/v1/auth/logout');
      assert.equal(calls[0].init?.method, 'POST');
      assert.equal(calls[0].init?.credentials, 'same-origin');
      assert.equal(calls[0].init?.body, undefined);
    },
  );
});

test('real requestAccountDeletion POSTs the reason to account/deletion-request', async () => {
  await withStubbedFetch(
    () => jsonResponse(202, { requestId: 'del_1' }),
    async (calls) => {
      const result = await requestAccountDeletion('  done with the demo  ');
      assert.deepEqual(result, { success: true });
      assert.equal(calls[0].input, '/api/v1/account/deletion-request');
      assert.equal(calls[0].init?.method, 'POST');
      assert.deepEqual(calls[0].init?.body, JSON.stringify({ reason: 'done with the demo' }));
    },
  );
});

test('real requestAccountDeletion sends an empty body without a reason', async () => {
  await withStubbedFetch(
    () => jsonResponse(202, { requestId: 'del_2' }),
    async (calls) => {
      await requestAccountDeletion();
      assert.deepEqual(calls[0].init?.body, JSON.stringify({}));
    },
  );
});

test('real loginApi logs never contain the phone number, SMS code, or invite code (SEC-12)', async () => {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await withStubbedFetch(
      (call) => (call.input === '/api/v1/auth/logout' ? new Response(null, { status: 204 }) : jsonResponse(200, { user: { id: 'u_1' }, tenant: TENANT_READY })),
      async () => {
        await sendCode(PHONE);
        await verifyCode(PHONE, '246810', { inviteCode: 'INVITE-TOKEN', displayName: 'Secret Name' });
        await getMe();
        await logout();
        await requestAccountDeletion('a reason');
      },
    );
  } finally {
    console.info = original;
  }
  const all = lines.join('\n');
  assert.ok(all.includes('[loginApi] sendCode'));
  assert.ok(all.includes('[loginApi] verifyCode'));
  assert.ok(all.includes('[loginApi] getMe'));
  assert.ok(all.includes('[loginApi] logout'));
  assert.ok(!all.includes(PHONE), 'phone number must not be logged');
  assert.ok(!all.includes('13800000000'), 'phone digits must not be logged');
  assert.ok(!all.includes('246810'), 'SMS code must not be logged');
  assert.ok(!all.includes('INVITE-TOKEN'), 'invite code must not be logged');
  assert.ok(!all.includes('Secret Name'), 'display name value must not be logged');
  assert.ok(!all.includes('a reason'), 'deletion reason must not be logged');
});

test('real sendCode forwards inviteCode when provided and omits it when blank', async () => {
  await withStubbedFetch(
    () => jsonResponse(200, { resendAfterSec: 60 }),
    async (calls) => {
      await sendCode(PHONE, 'login', { inviteCode: 'IDB-7K9M-X4' });
      await sendCode(PHONE, 'login', { inviteCode: '   ' });
      assert.deepEqual(
        calls[0].init?.body,
        JSON.stringify({ phone: PHONE, purpose: 'login', inviteCode: 'IDB-7K9M-X4' }),
      );
      assert.deepEqual(calls[1].init?.body, JSON.stringify({ phone: PHONE, purpose: 'login' }));
    },
  );
});

test('real previewInvite GETs /api/v1/auth/invite/preview and never logs the code', async () => {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await withStubbedFetch(
      () =>
        jsonResponse(200, {
          valid: true,
          code: 'IDB-SECRET-99',
          planId: 'me_pro',
          planName: 'ID.Student',
          planNameEn: 'ID.Student',
          periodDays: 14,
          registrationEnabled: true,
          dailyCapFull: false,
        }),
      async (calls) => {
        const res = await previewInvite('IDB-SECRET-99');
        assert.equal(res.valid, true);
        assert.equal(res.periodDays, 14);
        assert.equal(calls[0].input, '/api/v1/auth/invite/preview?code=IDB-SECRET-99');
        assert.equal(calls[0].init?.method, 'GET');
      },
    );
  } finally {
    console.info = original;
  }
  assert.ok(!lines.join('\n').includes('IDB-SECRET-99'), 'invite preview code must not be logged');
});
