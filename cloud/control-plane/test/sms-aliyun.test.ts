import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.js';
import {
  AliyunSmsProvider,
  buildAliyunSignedFormBody,
  normalizeAliyunPhoneNumber,
  popPercentEncode,
} from '../src/sms.js';
import { FakeDocker } from './fake-docker/index.mjs';
import { api, freshDb, startTestApp } from './helpers.js';

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    CP_PUBLIC_ORIGIN: 'https://app.idbots.world',
    CP_LISTEN: '127.0.0.1:8080',
    CP_METRICS_LISTEN: '127.0.0.1:9100',
    CP_DB_PATH: '/tmp/test-cp.sqlite',
    CP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    CP_DOCKER_URL: 'http://127.0.0.1:2375',
    CP_TENANT_IMAGE: 'fake-tenant:test',
    CP_TENANT_NETWORK: 'idbots-test',
    ...overrides,
  };
}

describe('AliyunSmsProvider & SMS config validation', () => {
  test('popPercentEncode follows Alibaba Cloud POP RFC 3986 rules', () => {
    assert.equal(popPercentEncode('a b+c~d*e!f(g)h\'i'), 'a%20b%2Bc~d%2Ae%21f%28g%29h%27i');
  });

  test('normalizeAliyunPhoneNumber strips +86 for 11-digit mainland numbers', () => {
    assert.equal(normalizeAliyunPhoneNumber('+8613800138000'), '13800138000');
    assert.equal(normalizeAliyunPhoneNumber('+85291234567'), '85291234567');
  });

  test('buildAliyunSignedFormBody produces canonical sorted query and HMAC-SHA1 signature', () => {
    const params = {
      Action: 'SendSms',
      AccessKeyId: 'testid',
      PhoneNumbers: '13800138000',
      TemplateParam: '{"code":"123456"}',
    };
    const body = buildAliyunSignedFormBody(params, 'testsecret', 'POST');
    const canonical =
      'AccessKeyId=testid&Action=SendSms&PhoneNumbers=13800138000&TemplateParam=%7B%22code%22%3A%22123456%22%7D';
    const expectedSig = createHmac('sha1', 'testsecret&')
      .update(`POST&%2F&${popPercentEncode(canonical)}`, 'utf8')
      .digest('base64');
    assert.equal(body, `Signature=${popPercentEncode(expectedSig)}&${canonical}`);
  });

  test('loadConfig enforces Aliyun SMS and invite service credentials', () => {
    assert.throws(
      () => loadConfig(baseEnv({ CP_SMS_MODE: 'aliyun' })),
      (err: unknown) => err instanceof ConfigError && /CP_SMS_ACCESS_KEY_ID/.test(err.message),
    );

    const cfg = loadConfig(
      baseEnv({
        CP_SMS_MODE: 'aliyun',
        CP_SMS_ACCESS_KEY_ID: 'LTAI_test',
        CP_SMS_ACCESS_KEY_SECRET: 'secret_test',
        CP_SMS_SIGN_NAME: 'IDBots',
        CP_SMS_TEMPLATE_LOGIN: 'SMS_10001',
        CP_INVITE_SERVICE_URL: 'https://abs.example.com/',
        CP_INVITE_API_TOKEN: 'partner_tok_123',
      }),
    );
    assert.equal(cfg.smsMode, 'aliyun');
    assert.equal(cfg.inviteService.baseUrl, 'https://abs.example.com');
    assert.equal(cfg.inviteService.token, 'partner_tok_123');

    assert.throws(
      () =>
        loadConfig(
          baseEnv({
            CP_SMS_MODE: 'aliyun',
            CP_SMS_ACCESS_KEY_ID: 'LTAI_test',
            CP_SMS_ACCESS_KEY_SECRET: 'secret_test',
            CP_SMS_SIGN_NAME: 'IDBots',
            CP_SMS_TEMPLATE_LOGIN: 'SMS_10001',
            CP_INVITE_SERVICE_URL: 'https://abs.example.com',
          }),
        ),
      (err: unknown) => err instanceof ConfigError && /CP_INVITE_API_TOKEN is required/.test(err.message),
    );
  });

  test('AliyunSmsProvider sends login and reverify templates and scrubs secrets on failure', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    let nextResponse = { status: 200, payload: { Code: 'OK', Message: 'OK' } };

    const provider = new AliyunSmsProvider({
      accessKeyId: 'LTAI_key_1',
      accessKeySecret: 'SUPER_SECRET_KEY_VALUE',
      signName: 'IDBots',
      templateLogin: 'SMS_LOGIN_1',
      templateReverify: 'SMS_REVERIFY_2',
      endpoint: 'https://dysmsapi.aliyuncs.com/',
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), body: String(init?.body ?? '') });
        return new Response(JSON.stringify(nextResponse.payload), {
          status: nextResponse.status,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await provider.send('+8613800138000', 'login', '654321');
    assert.equal(calls.length, 1);
    const loginParams = new URLSearchParams(calls[0].body);
    assert.equal(loginParams.get('PhoneNumbers'), '13800138000');
    assert.equal(loginParams.get('TemplateCode'), 'SMS_LOGIN_1');
    assert.equal(loginParams.get('TemplateParam'), '{"code":"654321"}');
    assert.ok(loginParams.get('Signature'));

    await provider.send('+8613800138000', 'reverify', '112233');
    const reverifyParams = new URLSearchParams(calls[1].body);
    assert.equal(reverifyParams.get('TemplateCode'), 'SMS_REVERIFY_2');

    nextResponse = {
      status: 200,
      payload: { Code: 'isv.BUSINESS_LIMIT_CONTROL', Message: 'frequency limit reached' },
    };
    await assert.rejects(
      () => provider.send('+8613800138000', 'login', '999888'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /isv\.BUSINESS_LIMIT_CONTROL/);
        assert.ok(!err.message.includes('SUPER_SECRET_KEY_VALUE'));
        assert.ok(!err.message.includes('13800138000'));
        assert.ok(!err.message.includes('999888'));
        return true;
      },
    );
  });

  test('failed real-provider SMS send returns 502 SMS_SEND_FAILED and rolls back cooldown row', async () => {
    const db = freshDb();
    const fake = new FakeDocker();
    await fake.listen(0);
    let shouldFail = true;
    const provider = new AliyunSmsProvider({
      accessKeyId: 'LTAI_key_1',
      accessKeySecret: 'SUPER_SECRET_KEY_VALUE',
      signName: 'IDBots',
      templateLogin: 'SMS_LOGIN_1',
      fetchImpl: async () =>
        new Response(
          JSON.stringify(
            shouldFail
              ? { Code: 'isv.SYSTEM_ERROR', Message: 'temporary upstream error' }
              : { Code: 'OK', Message: 'OK' },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    const t = await startTestApp({
      db,
      dockerUrl: fake.url(),
      smsProvider: provider,
    });

    try {
      const first = await api(t.baseUrl, '/api/v1/auth/sms/send', {
        method: 'POST',
        body: { phone: '+8613800138111', purpose: 'login' },
      });
      assert.equal(first.status, 502);
      assert.equal((first.json as { error?: { code?: string } })?.error?.code, 'SMS_SEND_FAILED');

      const countAfterFail = (
        db.prepare('SELECT COUNT(*) AS n FROM sms_codes WHERE phone_e164 = ?').get('+8613800138111') as {
          n: number;
        }
      ).n;
      assert.equal(countAfterFail, 0);

      // Immediate retry succeeds without hitting 60s cooldown because failed row was rolled back.
      shouldFail = false;
      const retry = await api(t.baseUrl, '/api/v1/auth/sms/send', {
        method: 'POST',
        body: { phone: '+8613800138111', purpose: 'login' },
      });
      assert.equal(retry.status, 200);
    } finally {
      await t.close();
      await fake.close();
      db.close();
    }
  });
});
