// Subscription expiry surfacing (2026-11-11 hardening).
//
// The /v1/me/subscription payload carries an expiry the UI never showed:
// paid users could not see how long their tier lasts, and expiry was
// silent (plan card just kept saying "active"). The field name is not
// contract-pinned, so both mirrors (desktop renderer store + mobile store)
// parse tolerantly across epoch s/ms and ISO shapes. These tests pin:
//   1. the parser on both mirrors + a drift guard between them;
//   2. the countdown units (expired / whole hours / days+hours — hour
//      precision since 2026-11-13: a plan bought at noon expires at noon);
//   3. the wiring: desktop plan card + mobile hero render the line, both
//      locales carry the copy, and no date is ever guessed when absent.
//
// Run: npx tsx --test tests/meSubscriptionExpiry.test.ts

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  formatMeExpiryDate as desktopFormatDate,
  meExpiryParts as desktopParts,
  meSubscriptionExpiryMs as desktopExpiryMs,
} from '../src/renderer/components/me/mePointsStore.ts';
import {
  formatMeExpiryDate as mobileFormatDate,
  meExpiryParts as mobileParts,
  meSubscriptionExpiryMs as mobileExpiryMs,
} from '../src/mobile/app/me/mePointsStore.ts';

const read = (rel: string): string => fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', rel),
  'utf8',
);

test('expiry parses epoch seconds, epoch ms and ISO strings from the raw payload', () => {
  const ISO = '2026-12-08T00:00:00Z';
  const isoMs = Date.parse(ISO);
  for (const [name, parse] of [['desktop', desktopExpiryMs], ['mobile', mobileExpiryMs]] as const) {
    assert.equal(parse({ statusText: 'active', raw: { expireAt: 1794000000 } }), 1794000000000, name);
    assert.equal(parse({ statusText: 'active', raw: { expires_at: 1794000000000 } }), 1794000000000, name);
    assert.equal(parse({ statusText: 'active', raw: { applicableEnd: ISO } }), isoMs, name);
    assert.equal(parse({ statusText: 'active', raw: { 'period_end': String(1794000000) } }), 1794000000000, name);
    assert.equal(parse({ statusText: 'active', raw: { currentPeriodEnd: ' 1794000000 ' } }), 1794000000000, name);
    // Absent / garbage → null, never a guessed date.
    assert.equal(parse({ statusText: 'active', raw: {} }), null, name);
    assert.equal(parse({ statusText: 'active', raw: { expireAt: 0 } }), null, name);
    assert.equal(parse({ statusText: 'active', raw: { expireAt: 'not-a-date' } }), null, name);
    assert.equal(parse({ statusText: 'active', raw: { expireAt: -5 } }), null, name);
    assert.equal(parse(null), null, name);
    assert.equal(parse({ statusText: 'active' }), null, name);
  }
});

test('countdown units: expired in the past, whole hours inside the last day, days+hours beyond', () => {
  const now = Date.now();
  for (const parts of [desktopParts, mobileParts]) {
    assert.deepEqual(parts(now - 1_000), { unit: 'expired', n: 0 });
    // Inside the last day the countdown rounds UP to whole hours (never "0
    // 小时" while time is left); test points sit safely inside each band so
    // the few ms between `now` and the helper's own Date.now() cannot flip
    // the bucket.
    assert.deepEqual(parts(now + 5 * 3_600_000), { unit: 'hours', n: 5 });
    assert.deepEqual(parts(now + 23 * 3_600_000), { unit: 'hours', n: 23 });
    assert.deepEqual(parts(now + 30 * 60_000), { unit: 'hours', n: 1 });
    // Beyond a day: whole days + whole hours, both floored. 90.5h → 3d 18.5h.
    assert.deepEqual(parts(now + 90.5 * 3_600_000), { unit: 'days', n: 3, hours: 18 });
    // 72.5h → 3 days and a 30-minute remainder: the hours slot reads 0.
    assert.deepEqual(parts(now + 72.5 * 3_600_000), { unit: 'days', n: 3, hours: 0 });
    assert.deepEqual(parts(now + 48.5 * 3_600_000), { unit: 'days', n: 2, hours: 0 });
    assert.deepEqual(parts(null), null);
    assert.deepEqual(parts(0), null);
  }
});

test('drift guard: desktop and mobile expiry parsers agree on representative payloads', () => {
  const payloads = [
    { statusText: 'active', raw: { expireAt: 1794000000 } },
    { statusText: 'active', raw: { applicableEnd: '2026-12-08T00:00:00Z' } },
    { statusText: 'active', raw: { endDate: 1794000000000 } },
    { statusText: 'active', raw: {} },
    null,
  ];
  for (const payload of payloads) {
    assert.equal(desktopExpiryMs(payload as never), mobileExpiryMs(payload as never));
  }
  assert.equal(desktopFormatDate(1794000000000), mobileFormatDate(1794000000000));
});

test('desktop plan card renders the expiry line only when subscribed and only from real data', () => {
  const source = read('src/renderer/components/me/IdbotsPlanCard.tsx');
  assert.match(source, /meSubscriptionExpiryMs\(snapshot\.subscription\)/);
  assert.match(source, /subscribed \? meSubscriptionExpiryMs/);
  assert.match(source, /i18nService\.t\('mePlanExpiresIn'\)/);
  assert.match(source, /i18nService\.t\('mePlanExpiresToday'\)/);
  assert.match(source, /i18nService\.t\('mePlanExpiredOn'\)/);
  assert.match(source, /data-testid="idbots-plan-expiry"/);
});

test('mobile hero renders the expiry line and MeScreen feeds it from the subscription payload', () => {
  const hero = read('src/mobile/app/components/MePointsHero.tsx');
  assert.match(hero, /expiryMs\?: number \| null/);
  assert.match(hero, /data-testid="me-points-expiry"/);
  assert.match(hero, /t\('mobile\.me\.points\.expiresIn'/);
  const screen = read('src/mobile/app/screens/MeScreen.tsx');
  assert.match(screen, /expiryMs=\{expiryMs\}/);
  assert.match(screen, /meSubscriptionExpiryMs\(me\.subscription\)/);
  // The home-page tier cards ride the same downgrade guard as the purchase screen.
  assert.match(screen, /activeTierKey=\{activeTierKey\}/);
  assert.match(screen, /subscribed=\{subscribed\}/);
});

test('expiry copy exists in BOTH locales on desktop and mobile', () => {
  const desktop = read('src/renderer/services/i18n.ts');
  for (const key of ['mePlanExpiresIn', 'mePlanExpiresToday', 'mePlanExpiredOn']) {
    const first = desktop.indexOf(`${key}: '`);
    assert.ok(first > 0, `desktop zh key missing: ${key}`);
    assert.ok(desktop.indexOf(`${key}: '`, first + 1) > 0, `desktop en key missing: ${key}`);
  }
  const mobile = read('src/mobile/i18n.ts');
  for (const key of ['mobile.me.points.expiresIn', 'mobile.me.points.expiresToday', 'mobile.me.points.expiredOn']) {
    const first = mobile.indexOf(`'${key}'`);
    assert.ok(first > 0, `mobile zh key missing: ${key}`);
    assert.ok(mobile.indexOf(`'${key}'`, first + 1) > 0, `mobile en key missing: ${key}`);
  }
});
