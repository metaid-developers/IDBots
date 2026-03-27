/**
 * IM Gateway connectivity tests.
 * - Telegram probe: trim token, retry, success/fail/network error handling.
 * Run: npm run compile:electron && node --test tests/imGatewayConnectivity.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mock } from 'node:test';

const require = createRequire(import.meta.url);
const axios = require('axios');
const { probeTelegramAuth } = require('../dist-electron/im/telegramProbe.js');

function restoreAxiosGet() {
  try {
    mock.reset();
  } catch (_) {
    // no-op if not supported
  }
}

test('probeTelegramAuth: success returns message with bot username', async () => {
  mock.method(axios, 'get', async () => ({
    data: { ok: true, result: { id: 123, username: 'idbots_test_bot', first_name: 'Test' } },
    status: 200,
  }));
  try {
    const message = await probeTelegramAuth('123456:ABC-DEF', { timeoutMs: 5000, retries: 1 });
    assert.ok(message.includes('@idbots_test_bot'), 'message should include bot username');
    assert.ok(message.includes('鉴权通过'), 'message should indicate success');
  } finally {
    restoreAxiosGet();
  }
});

test('probeTelegramAuth: trims token before request', async () => {
  let capturedUrl = '';
  mock.method(axios, 'get', async (url) => {
    capturedUrl = url;
    return { data: { ok: true, result: { username: 'trimmed_bot' } }, status: 200 };
  });
  try {
    await probeTelegramAuth('  \n  123:token  \n  ', { timeoutMs: 5000, retries: 1 });
    assert.ok(capturedUrl.includes('123:token'), 'URL should use trimmed token without surrounding spaces');
    assert.ok(!capturedUrl.includes('\n'), 'URL should not contain newlines');
  } finally {
    restoreAxiosGet();
  }
});

test('probeTelegramAuth: empty token throws', async () => {
  await assert.rejects(
    () => probeTelegramAuth(''),
    { message: /Bot token is required/ }
  );
  await assert.rejects(
    () => probeTelegramAuth('   \n  '),
    { message: /Bot token is required/ }
  );
});

test('probeTelegramAuth: invalid token (401) throws with API description', async () => {
  mock.method(axios, 'get', async () => ({
    data: { ok: false, description: 'Unauthorized' },
    status: 200,
  }));
  try {
    await assert.rejects(
      () => probeTelegramAuth('bad-token', { timeoutMs: 5000, retries: 1 }),
      { message: /Unauthorized/ }
    );
  } finally {
    restoreAxiosGet();
  }
});

test('probeTelegramAuth: network timeout throws user-friendly message', async () => {
  const timeoutErr = new Error('timeout of 5000ms exceeded');
  timeoutErr.code = 'ECONNABORTED';
  mock.method(axios, 'get', async () => {
    throw timeoutErr;
  });
  try {
    await assert.rejects(
      () => probeTelegramAuth('123:token', { timeoutMs: 5000, retries: 1 }),
      { message: /连接 Telegram API 超时|请检查网络/ }
    );
  } finally {
    restoreAxiosGet();
  }
});

test('probeTelegramAuth: ENOTFOUND throws user-friendly message', async () => {
  const err = new Error('getaddrinfo ENOTFOUND api.telegram.org');
  err.code = 'ENOTFOUND';
  mock.method(axios, 'get', async () => {
    throw err;
  });
  try {
    await assert.rejects(
      () => probeTelegramAuth('123:token', { timeoutMs: 5000, retries: 1 }),
      { message: /无法连接 api.telegram.org|请检查网络|配置代理/ }
    );
  } finally {
    restoreAxiosGet();
  }
});
