/**
 * MVC Subsidy Service verification tests.
 * Creates a wallet via metabotWalletService, then requests gas subsidy for the mvc_address.
 * Requires network; set SKIP_NETWORK_TESTS=1 to skip (e.g. in CI or offline).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMetaBotWallet } = require('../dist-electron/services/metabotWalletService.js');
const { requestMvcGasSubsidy } = require('../dist-electron/services/mvcSubsidyService.js');

const skipNetwork = process.env.SKIP_NETWORK_TESTS === '1';

test('requestMvcGasSubsidy: step 1 only (mvcAddress without mnemonic)', async () => {
  if (skipNetwork) {
    return;
  }
  const wallet = await createMetaBotWallet();
  const result = await requestMvcGasSubsidy({ mvcAddress: wallet.mvc_address });
  assert.ok('success' in result, 'result has success');
  assert.ok('step1' in result || result.error, 'result has step1 or error');
  if (result.success) {
    assert.ok(result.step1 !== undefined, 'step1 present on success');
  }
});

test('requestMvcGasSubsidy: full flow with wallet mvc_address and mnemonic', async () => {
  if (skipNetwork) {
    return;
  }
  const wallet = await createMetaBotWallet();
  const result = await requestMvcGasSubsidy({
    mvcAddress: wallet.mvc_address,
    mnemonic: wallet.mnemonic,
    path: wallet.path,
  });
  assert.ok('success' in result, 'result has success');
  if (result.success) {
    assert.ok(result.step1 !== undefined, 'step1 present');
    assert.ok(result.step2 !== undefined, 'step2 present');
  } else {
    assert.ok(typeof result.error === 'string', 'error message present');
  }
});

test('requestMvcGasSubsidy: rejects empty mvcAddress', async () => {
  const result = await requestMvcGasSubsidy({ mvcAddress: '' });
  assert.equal(result.success, false);
  assert.ok(result.error?.includes('mvcAddress'));
});
