import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let addressBalanceService;
try {
  addressBalanceService = require('../dist-electron/services/addressBalanceService.js');
} catch {
  addressBalanceService = null;
}

test('getAddressBalance aborts slow balance fetches with a timeout error', async () => {
  assert.equal(
    typeof addressBalanceService?.getAddressBalance,
    'function',
    'getAddressBalance() should be exported',
  );

  const originalFetch = global.fetch;
  global.fetch = (_url, init = {}) => new Promise((_resolve, reject) => {
    const signal = init.signal;
    const fallbackTimer = setTimeout(() => {
      reject(new Error('fetch mock should have been aborted'));
    }, 1_000);
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => {
        clearTimeout(fallbackTimer);
        reject(signal.reason ?? new Error('aborted'));
      }, { once: true });
    }
  });

  try {
    await assert.rejects(
      addressBalanceService.getAddressBalance('mvc', 'mvc-1', { timeoutMs: 20 }),
      /Failed to fetch MVC balance: timeout/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});
