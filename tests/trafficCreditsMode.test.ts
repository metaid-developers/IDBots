import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  creditsSpendableMilli,
  formatOrderMe,
  journalEntriesToOrders,
} from '../src/renderer/components/traffic/creditsTraffic';
import { meteringTagLabel } from '../src/renderer/components/me/MeUsageAndCredits';

test('creditsSpendableMilli prefers the sponsor figure, then the balance figure', () => {
  const balance = {
    weeklyGrant: { remainingMilli: 1_000 },
    persistent: { topupMilli: 5_000, bonusMilli: 0, earnedMilli: 0 },
    spendableMilli: 4_000,
  };
  assert.equal(creditsSpendableMilli({ sponsorSpendableMilli: 0, balance }), 0);
  assert.equal(creditsSpendableMilli({ sponsorSpendableMilli: 2_500, balance }), 2_500);
  assert.equal(creditsSpendableMilli({ balance }), 4_000);
});

test('creditsSpendableMilli rebuilds the rule from the pools when no figure is reported', () => {
  const pools = {
    weeklyGrant: { remainingMilli: 1_000 },
    persistent: { topupMilli: 5_000, bonusMilli: 200, earnedMilli: 300 },
  };
  // Auto-deduct on (or not reported): grant + every persistent pool.
  assert.equal(creditsSpendableMilli({ balance: pools }), 6_500);
  assert.equal(creditsSpendableMilli({ balance: { ...pools, autoDeductFromPersistent: true } }), 6_500);
  // Credit-pack switch off: the weekly grant only.
  assert.equal(creditsSpendableMilli({ balance: { ...pools, autoDeductFromPersistent: false } }), 1_000);
  // Unknown is not empty.
  assert.equal(creditsSpendableMilli({ balance: null }), undefined);
  assert.equal(creditsSpendableMilli({}), undefined);
});

test('formatOrderMe keeps milliME resolution below 1 ME', () => {
  assert.equal(formatOrderMe(12), '0.012');
  assert.equal(formatOrderMe(0), '0');
  assert.equal(formatOrderMe(1_000), '1');
  assert.equal(formatOrderMe(20_000), '20');
  assert.equal(formatOrderMe(Number.NaN), '0');
});

test('journalEntriesToOrders maps billedBy to the order pay source', () => {
  const base = { id: 1, txId: 'aa', botAddress: 'bot', orderId: 'o1', txSize: 616, sponsoredMinerFee: 616, savedFee: 616, kind: '/protocols/simplebuzz', createdAt: 5 };
  const [me, bytes, quota] = journalEntriesToOrders([
    { ...base, billedBy: 'me', meAmountMilli: 12 },
    { ...base, orderId: 'o2', billedBy: 'traffic', meAmountMilli: 99, kind: '' },
    { ...base, orderId: 'o3', billedBy: 'quota', meAmountMilli: 0 },
  ]);
  assert.equal(me.paySource, 'me');
  assert.equal(me.meAmountMilli, 12);
  assert.equal(me.kind, '/protocols/simplebuzz');
  assert.equal(me.committedAt, 5);
  assert.equal(bytes.paySource, 'bytes');
  assert.equal(bytes.meAmountMilli, 0);
  assert.equal('kind' in bytes, false);
  assert.equal(quota.paySource, 'quota');
});

test('metering tags render for both the metering:<line> refType and the bare line', () => {
  assert.equal(meteringTagLabel('metering:traffic'), 'TRAFFIC');
  assert.equal(meteringTagLabel('metering:llm'), 'LLM');
  assert.equal(meteringTagLabel('METERING:agent'), 'AGENT');
  assert.equal(meteringTagLabel('traffic'), 'TRAFFIC');
  assert.equal(meteringTagLabel('topup'), null);
  assert.equal(meteringTagLabel(undefined), null);
});

test('the traffic tab gates the credits UI on the sponsor ME billing capability', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/renderer/components/traffic/TrafficSettings.tsx'),
    'utf8',
  );
  // One capability flag picks the world; the byte balance stays until it is live.
  assert.match(source, /const creditsMode = meBilling\?\.trafficBilling === true;/);
  assert.match(source, /getMeBillingStatus\(/);
  // Credits mode: switch + shared ME card + per-order history.
  assert.match(source, /role="switch"[\s\S]*trafficCreditsPayTitle/);
  assert.match(source, /<MeBalanceOverviewCard note=/);
  assert.match(source, /getSponsorOrders\(/);
  // The 积分支付 switch rides the existing traffic.mode values (D3 grandfathering).
  assert.match(source, /handleSelectMode\(creditsPaymentOn \? 'selfpay' : 'traffic'\)/);
});

test('zh and en ship every credits-mode string', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/renderer/services/i18n.ts'), 'utf8');
  const keys = [
    'trafficCreditsPayTitle',
    'trafficCreditsPayDesc',
    'trafficCreditsPayOnHint',
    'trafficCreditsPayOffHint',
    'trafficCreditsBalanceNote',
    'trafficCreditsEmptyWarning',
    'trafficCreditsBuy',
    'trafficCreditsRefresh',
    'trafficOrdersTitle',
    'trafficOrdersEmpty',
    'trafficOrdersLocalOnly',
    'trafficOrderBilledBytes',
    'trafficOrderBilledQuota',
    'trafficTableMe',
  ];
  for (const key of keys) {
    const occurrences = source.match(new RegExp(`\\b${key}:`, 'g')) ?? [];
    assert.equal(occurrences.length, 2, `${key} must exist in both zh and en`);
  }
});
