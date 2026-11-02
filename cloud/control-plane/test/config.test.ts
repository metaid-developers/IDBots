import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ConfigError, assertFakeSmsOriginAllowed, loadConfig } from '../src/config.js';

const PRODUCTION_ORIGIN = 'https://app.idbots.world/';

/** Minimal complete env (REQ-B required keys) for loadConfig-level tests. */
function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    CP_PUBLIC_ORIGIN: PRODUCTION_ORIGIN,
    CP_LISTEN: '127.0.0.1:8080',
    CP_METRICS_LISTEN: '127.0.0.1:9100',
    CP_DB_PATH: '/tmp/test-cp.sqlite',
    CP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    CP_DOCKER_URL: 'http://127.0.0.1:2375',
    CP_TENANT_IMAGE: 'fake-tenant:test',
    CP_TENANT_NETWORK: 'idbots-test',
    CP_SMS_MODE: 'fake',
    CP_FAKE_SMS_NUMBERS: '+8613900000100',
    ...overrides,
  };
}

describe('assertFakeSmsOriginAllowed (default, no explicit flag)', () => {
  test('allows localhost, 127.0.0.1 and [::1] origins in fake mode', () => {
    for (const origin of ['http://localhost:5173/', 'http://127.0.0.1:8080/', 'http://[::1]:8080/']) {
      assertFakeSmsOriginAllowed(new URL(origin), 'fake');
    }
  });

  test('allows *.staging origins in fake mode', () => {
    assertFakeSmsOriginAllowed(new URL('https://staging.example.com/'), 'fake');
  });

  test('refuses a production origin in fake mode', () => {
    assert.throws(
      () => assertFakeSmsOriginAllowed(new URL(PRODUCTION_ORIGIN), 'fake'),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /CP_SMS_MODE=fake is only allowed/);
        return true;
      },
    );
  });

  test('never restricts aliyun mode regardless of origin', () => {
    assertFakeSmsOriginAllowed(new URL(PRODUCTION_ORIGIN), 'aliyun');
  });
});

describe('assertFakeSmsOriginAllowed with CP_SMS_FAKE_ORIGIN_EXPLICIT=true', () => {
  test('allows any origin in fake mode when the flag is explicitly on', () => {
    assertFakeSmsOriginAllowed(new URL(PRODUCTION_ORIGIN), 'fake', true);
  });

  test('staging and localhost remain allowed with the flag on (no behavior change)', () => {
    assertFakeSmsOriginAllowed(new URL('https://staging.example.com/'), 'fake', true);
    assertFakeSmsOriginAllowed(new URL('http://localhost:5173/'), 'fake', true);
  });
});

describe('loadConfig env plumbing for CP_SMS_FAKE_ORIGIN_EXPLICIT', () => {
  test('production origin + fake mode + flag=true loads successfully', () => {
    const config = loadConfig(baseEnv({ CP_SMS_FAKE_ORIGIN_EXPLICIT: 'true' }));
    assert.equal(config.publicOrigin, PRODUCTION_ORIGIN);
    assert.equal(config.smsMode, 'fake');
  });

  test('production origin + fake mode without the flag still refuses (default unchanged)', () => {
    assert.throws(
      () => loadConfig(baseEnv()),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /CP_SMS_MODE=fake is only allowed/);
        return true;
      },
    );
  });

  test('"1" is accepted as an explicit-true spelling', () => {
    loadConfig(baseEnv({ CP_SMS_FAKE_ORIGIN_EXPLICIT: '1' }));
  });

  test('any other value is a config error rather than a silent off', () => {
    assert.throws(
      () => loadConfig(baseEnv({ CP_SMS_FAKE_ORIGIN_EXPLICIT: 'yes' })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /CP_SMS_FAKE_ORIGIN_EXPLICIT must be "true" or unset/);
        return true;
      },
    );
  });

  test('the flag does not bypass the CP_FAKE_SMS_NUMBERS requirement', () => {
    assert.throws(
      () => loadConfig(baseEnv({ CP_SMS_FAKE_ORIGIN_EXPLICIT: 'true', CP_FAKE_SMS_NUMBERS: '' })),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /CP_FAKE_SMS_NUMBERS is empty/);
        return true;
      },
    );
  });
});
