import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { requestMvcGasSubsidy } = require('../dist-electron/services/mvcSubsidyService.js');

const FIXTURE_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const FIXTURE_PATH = "m/44'/10001'/0'/0/0";
const FIXTURE_ADDRESS = '15Lofqw6Kpa6P8WnTYXKvmPyw3UZvvQWrB';

test('requestMvcGasSubsidy completes the init-only flow when mnemonic is omitted', async () => {
  const calls = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ stage: 'init' })
    };
  };

  try {
    const result = await requestMvcGasSubsidy({
      mvcAddress: FIXTURE_ADDRESS
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.step1, { stage: 'init' });
    assert.equal(calls.length, 1);
    assert.match(String(calls[0].url), /address-init$/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('requestMvcGasSubsidy completes the reward flow when mnemonic is present', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;

  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ stage: calls.length === 1 ? 'init' : 'reward' })
    };
  };
  global.setTimeout = ((callback, _ms, ...args) => {
    callback(...args);
    return 0;
  });

  try {
    const result = await requestMvcGasSubsidy({
      mvcAddress: FIXTURE_ADDRESS,
      mnemonic: FIXTURE_MNEMONIC,
      path: FIXTURE_PATH
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.step1, { stage: 'init' });
    assert.deepEqual(result.step2, { stage: 'reward' });
    assert.equal(calls.length, 2);
    assert.match(String(calls[0].url), /address-init$/);
    assert.match(String(calls[1].url), /address-reward$/);
    assert.equal(typeof calls[1].options.headers['X-Signature'], 'string');
    assert.equal(typeof calls[1].options.headers['X-Public-Key'], 'string');
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  }
});
