// ME ledger signed-amount formatting (2026-11-10 release-review P2).
//
// formatMeSigned used to truncate to whole ME, so every sub-1-ME metering
// burn (a single sponsored write costs a few milliME) rendered as "-0" in
// the ME 流水 lists — desktop and mobile. Now sub-1-ME amounts keep up to
// three decimals (mirroring the per-order formatter in creditsTraffic) and
// amounts >= 1 ME keep one decimal.
//
// Run: npx tsx --test tests/meLedgerFormatting.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';

import { formatMeSigned as desktopFormat } from '../src/renderer/components/me/mePointsStore';
import { formatMeSigned as mobileFormat } from '../src/mobile/app/me/mePointsStore';

test('desktop: sub-1-ME spends keep three decimals instead of printing -0', () => {
  assert.equal(desktopFormat(-4), '-0.004');
  assert.equal(desktopFormat(-12.5), '-0.013', '3-decimal rounding, never -0');
  assert.equal(desktopFormat(7), '+0.007');
  assert.equal(desktopFormat(-999), '-0.999');
});

test('desktop: amounts >= 1 ME keep two decimals, integers stay integers', () => {
  assert.equal(desktopFormat(1000), '+1');
  assert.equal(desktopFormat(-1500), '-1.5');
  assert.equal(desktopFormat(-26_730), '-26.73', 'milli-ME stays visible above 1 ME');
  assert.equal(desktopFormat(1_000_000), '+1,000', 'grouping preserved');
});

test('desktop: null/undefined/NaN fall back to +0', () => {
  assert.equal(desktopFormat(null), '+0');
  assert.equal(desktopFormat(undefined), '+0');
  assert.equal(desktopFormat(Number.NaN), '+0');
});

test('mobile: same contract as the desktop formatter', () => {
  assert.equal(mobileFormat(-4), '-0.004');
  assert.equal(mobileFormat(-1500), '-1.5');
  assert.equal(mobileFormat(-26_730), '-26.73');
  assert.equal(mobileFormat(1000), '+1');
  assert.equal(mobileFormat(null), '+0');
});
