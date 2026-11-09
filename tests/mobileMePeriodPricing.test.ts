// Mobile ME period pricing — uniform monthly-rate model (2026-11-10).
//
// The mobile screen showed quarter/year prices from the retired per-plan
// fields (quarterlyDiscountPct / annualPriceCny) while the server and the
// desktop tag price with the uniform monthly-rate model (quarter = monthly
// x 3 x 90%, year = monthly x 12 x 80%, one 2dp rounding) — the QR amount
// could exceed or undercut the server-priced order (release-review P1).
//
// These tests pin:
//   1. the mobile arithmetic (mePeriodPrice) against the uniform model;
//   2. a drift guard: mobile and desktop (mePayment.mePeriodPricing) MUST
//      produce the same total for the same monthly base — if one side's
//      percentages or rounding change without the other, this goes red;
//   3. the retired plan fields are ignored for pricing.
//
// Run: node --test tests/mobileMePeriodPricing.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';

import { mePeriodPrice, type MobileMePlan } from '../src/mobile/app/me/mePointsStore.ts';
import { mePeriodPricing } from '../src/renderer/components/me/mePayment.ts';

function plan(priceCny: number | null, extra: Partial<MobileMePlan> = {}): MobileMePlan {
  return {
    planId: 'me_standard',
    tier: 'standard',
    name: 'ID.Pupil',
    priceCny,
    periodDays: 30,
    saleStatus: 1,
    ...extra,
  } as MobileMePlan;
}

test('month bills the list price, quarter 3x90%, year 12x80% with one 2dp rounding', () => {
  assert.equal(mePeriodPrice(plan(99), 'month'), 99);
  assert.equal(mePeriodPrice(plan(99), 'quarter'), 267.3);
  assert.equal(mePeriodPrice(plan(99), 'year'), 950.4);
  // Fractional monthly: 33.33 x 3 x 0.9 = 89.991 -> 89.99 (round once);
  // 33.33 x 12 x 0.8 = 319.968 -> 319.97.
  assert.equal(mePeriodPrice(plan(33.33), 'quarter'), 89.99);
  assert.equal(mePeriodPrice(plan(33.33), 'year'), 319.97);
});

test('drift guard: mobile matches the desktop mePeriodPricing arithmetic', () => {
  for (const monthly of [49, 99, 149, 199, 499]) {
    for (const period of ['month', 'quarter', 'year'] as const) {
      const desktop = mePeriodPricing({ monthly, period });
      assert.equal(
        mePeriodPrice(plan(monthly), period),
        desktop.total,
        `mobile vs desktop mismatch for monthly=${monthly} period=${period}`,
      );
    }
  }
});

test('retired per-plan fields (quarterlyDiscountPct / annualPriceCny) are ignored', () => {
  assert.equal(mePeriodPrice(plan(99, { quarterlyDiscountPct: 70, annualPriceCny: 899 }), 'quarter'), 267.3);
  assert.equal(mePeriodPrice(plan(99, { quarterlyDiscountPct: 70, annualPriceCny: 899 }), 'year'), 950.4);
});

test('missing or non-positive priceCny yields null (no invented price)', () => {
  assert.equal(mePeriodPrice(plan(null), 'month'), null);
  assert.equal(mePeriodPrice(plan(0), 'year'), null);
  assert.equal(mePeriodPrice(null, 'quarter'), null);
});
