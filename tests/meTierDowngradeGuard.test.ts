// Tier ladder guard (owner policy 2026-11-11): no plan changes DOWNWARD
// while a subscription is active — a mid-period downgrade would need a
// refund path the server does not offer. The current paid plan itself stays
// orderable (that is the renewal path); higher tiers are plain upgrades.
//
// The guard exists as TWO mirrors (the mobile bundle cannot import renderer
// code): desktop `mePayment.meTierRank / isMePlanDowngrade` and the mobile
// store copy. These tests pin the ladder semantics on both and a drift
// guard between them — if one side's ranks change without the other, this
// goes red.
//
// Run: npx tsx --test tests/meTierDowngradeGuard.test.ts

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  isMePlanDowngrade as desktopIsDowngrade,
  meTierRank as desktopRank,
} from '../src/renderer/components/me/mePayment.ts';
import {
  isMePlanDowngrade as mobileIsDowngrade,
  meActiveTierKey,
  meTierRank as mobileRank,
} from '../src/mobile/app/me/mePointsStore.ts';

const read = (rel: string): string => fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', rel),
  'utf8',
);

const LADDER = ['free', 'standard', 'pro', 'max'] as const;

test('ladder ranks: free < standard < pro < max, tolerant of plan-id and case variants', () => {
  for (const [implName, rank] of [['desktop', desktopRank], ['mobile', mobileRank]] as const) {
    assert.equal(rank('free'), 0, implName);
    assert.equal(rank('standard'), 1, implName);
    assert.equal(rank('pro'), 2, implName);
    assert.equal(rank('max'), 3, implName);
    // Plan ids and server casing normalize onto the same ladder.
    assert.equal(rank('me_standard'), 1, implName);
    assert.equal(rank('Me_Pro'), 2, implName);
    assert.equal(rank(' me_max '), 3, implName);
    // Unknown tiers rank last (-1) and never drive the guard.
    assert.equal(rank('xyz'), -1, implName);
    assert.equal(rank(''), -1, implName);
  }
});

test('downgrade detection: lower tiers locked, same tier (renewal) and upgrades allowed', () => {
  for (const isDowngrade of [desktopIsDowngrade, mobileIsDowngrade]) {
    assert.equal(isDowngrade('max', 'pro'), true, 'Scholar → Student must count as a downgrade');
    assert.equal(isDowngrade('max', 'standard'), true);
    assert.equal(isDowngrade('standard', 'free'), true);
    assert.equal(isDowngrade('me_max', 'me_pro'), true, 'plan-id keys resolve through the same ladder');
    // Renewal (same tier) is NOT a downgrade.
    assert.equal(isDowngrade('pro', 'pro'), false);
    assert.equal(isDowngrade('me_standard', 'standard'), false);
    // Upgrades stay orderable.
    assert.equal(isDowngrade('free', 'standard'), false);
    assert.equal(isDowngrade('standard', 'max'), false);
    // Unknown active tier or unknown target: never locked (an unseen catalog
    // tier must stay purchasable rather than get blocked by a guess).
    assert.equal(isDowngrade('', 'standard'), false);
    assert.equal(isDowngrade('xyz', 'free'), false);
    assert.equal(isDowngrade('max', 'xyz'), false);
  }
});

test('drift guard: desktop and mobile guards agree on every key pair', () => {
  const keys = [...LADDER, 'me_standard', 'ME_MAX', '', 'weird-tier'];
  for (const active of keys) {
    for (const target of keys) {
      assert.equal(
        desktopIsDowngrade(active, target),
        mobileIsDowngrade(active, target),
        `desktop/mobile downgrade mismatch for active=${active} target=${target}`,
      );
    }
  }
});

test('mobile active tier key prefers the raw subscription tier, falls back to the plan id', () => {
  assert.equal(meActiveTierKey({ statusText: 'active', raw: { tier: 'pro', planId: 'me_standard' } }), 'pro');
  assert.equal(meActiveTierKey({ statusText: 'active', raw: { planId: 'me_standard' } }), 'me_standard');
  assert.equal(meActiveTierKey({ statusText: 'active', raw: {} }), '');
  assert.equal(meActiveTierKey(null), '');
});

// ---------------------------------------------------------------------------
// Wiring pins (source-level, same style as tests/meSubscriptionOrder.test.mjs)
// ---------------------------------------------------------------------------

test('mobile MeTierCards renders locked tiers disabled with the downgrade badge', () => {
  const source = read('src/mobile/app/components/MeTierCards.tsx');
  assert.match(source, /isMePlanDowngrade\(props\.activeTierKey \?\? props\.activePlanId, plan\.tier\)/);
  // The current tier is never locked (it is the renewal path).
  assert.match(source, /!isCurrent\s*&&\s*isMePlanDowngrade/);
  assert.match(source, /disabled=\{isLocked\}/);
  assert.match(source, /me-tier-card-locked/);
  assert.match(source, /t\('mobile\.me\.points\.tierDowngradeLocked'\)/);
});

test('mobile MePurchaseScreen never selects or submits a locked tier', () => {
  const source = read('src/mobile/app/screens/MePurchaseScreen.tsx');
  assert.match(source, /const selectablePlans = useMemo\(/);
  assert.match(source, /paidPlans\.filter\(\(plan\) => !isMePlanDowngrade\(activeTierKey, plan\.tier\)\)/);
  assert.match(source, /subscribed=\{subscribed\}/);
  assert.match(source, /activeTierKey=\{activeTierKey\}/);
  // Submit-time defense in depth: a locked selection cannot create an order.
  assert.match(source, /!selectedPlan \|\| isMePlanDowngrade\(activeTierKey, selectedPlan\.tier\)/);
});

test('mobile i18n carries the downgrade badge in BOTH locales', () => {
  const source = read('src/mobile/i18n.ts');
  const zh = source.indexOf("'mobile.me.points.tierDowngradeLocked'");
  assert.ok(zh > 0, 'zh key missing');
  assert.ok(
    source.indexOf("'mobile.me.points.tierDowngradeLocked'", zh + 1) > 0,
    'en key missing',
  );
});
