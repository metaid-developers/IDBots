import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fetchMePaymentCheckout, mergeMePaymentCheckout } from '../src/mobile/app/me/meCheckout.ts';
import {
  clearMeCheckoutRecovery,
  loadMeCheckoutRecovery,
  saveMeCheckoutRecovery,
} from '../src/mobile/app/me/meCheckoutRecovery.ts';

function installStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

test('checkout recovery stores only order routing fields and clears the matching order', () => {
  const host = globalThis as unknown as { window?: { localStorage: Storage } };
  const previous = host.window;
  host.window = { localStorage: installStorage() };
  try {
    saveMeCheckoutRecovery({
      section: 'subscribe',
      orderId: 'sub-1',
      planId: 'me_pro',
      period: 'quarter',
      gateway: 'paypal',
      createdAt: 123,
    });
    assert.deepEqual(loadMeCheckoutRecovery(), {
      section: 'subscribe',
      orderId: 'sub-1',
      planId: 'me_pro',
      period: 'quarter',
      gateway: 'paypal',
      createdAt: 123,
    });
    clearMeCheckoutRecovery('another-order');
    assert.equal(loadMeCheckoutRecovery()?.orderId, 'sub-1');
    clearMeCheckoutRecovery('sub-1');
    assert.equal(loadMeCheckoutRecovery(), null);
  } finally {
    if (previous) host.window = previous;
    else delete host.window;
  }
});

test('a missing order clears stale cross-account recovery instead of showing an error', () => {
  const source = fs.readFileSync(new URL('../src/mobile/app/screens/MePurchaseScreen.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(!next\) \{\s*clearMeCheckoutRecovery\(recovery\.orderId\);\s*setPhase\('form'\);\s*return;\s*\}/);
  const missingBranch = source.slice(source.indexOf('if (!next)'), source.indexOf('if (!next)') + 180);
  assert.ok(!missingBranch.includes('setSubmitError'), 'missing orders silently reset to a fresh checkout');
});

test('subscription status checks read the authoritative order and preserve the payment handoff', async () => {
  const checkout = await fetchMePaymentCheckout({
    api: {
      getSubscriptionOrder: async () => ({
        success: true,
        subscriptionOrder: {
          orderId: 'sub-2',
          status: 'confirmed',
          payAmount: 199,
          gatewayParams: { approvalUrl: 'https://pay.example/sub-2' },
        },
      }),
    } as never,
    section: 'subscribe',
    orderId: 'sub-2',
  });
  assert.equal(checkout?.status, 'confirmed');
  assert.equal(checkout?.approvalUrl, 'https://pay.example/sub-2');
  const merged = mergeMePaymentCheckout(checkout, {
    ...checkout!,
    approvalUrl: '',
    qrCode: '',
  });
  assert.equal(merged.approvalUrl, 'https://pay.example/sub-2');
});

test('top-up status checks select the requested order rather than a stale previous QR', async () => {
  const checkout = await fetchMePaymentCheckout({
    api: {
      getTopupOrders: async () => ({
        success: true,
        orders: [
          { orderId: 'old', status: 'submitted', gatewayParams: { qrCode: 'old-qr' } },
          { orderId: 'new', status: 'submitted', payAmount: 90, gatewayParams: { qrCode: 'new-qr' } },
        ],
      }),
    } as never,
    section: 'topup',
    orderId: 'new',
  });
  assert.equal(checkout?.orderId, 'new');
  assert.equal(checkout?.qrCode, 'new-qr');
  assert.equal(checkout?.payAmount, 90);
});
