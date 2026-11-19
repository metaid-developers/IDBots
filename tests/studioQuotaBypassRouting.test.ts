// Quota-exhaustion routing memory (2026-11-18 Studio long-session
// post-mortem, owner ruling 2026-11-19: prompt for recharge, then auto-switch
// to an owned payable provider — automatic + visible, low friction).
//
// The incident session re-attempted the free relay on EVERY turn for nine
// hours: each turn paid a doomed 429 attempt + an auto-continue + a switch
// notice (16 in total) while the ME balance could not have paid for a single
// request. The fix remembers the exhausted provider (account-wide) and routes
// subsequent turns straight to a payable alternative, with ONE bypass notice
// per exhaustion period per session and a 10-minute re-probe so a recharge
// recovers the primary route without a restart.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '../src/main/libs/coworkRunner.ts'), 'utf8');

test('the runner keeps an account-wide provider quota-exhaustion memory with a bounded re-probe window', () => {
  assert.ok(
    source.includes('private readonly providerQuotaExhausted'),
    'coworkRunner: the quota-exhaustion registry must exist',
  );
  assert.ok(
    source.includes('PROVIDER_QUOTA_REPROBE_AFTER_MS = 10 * 60 * 1000'),
    'coworkRunner: the re-probe window must be bounded (10 minutes), not sticky forever',
  );
});

test('the quota pre-gate runs before the turn and bypasses the dead route on every in-turn attempt', () => {
  // The gate consults the registry before the FIRST attempt…
  assert.ok(
    source.includes('const quotaBypassEntry = this.quotaExhaustedBypassEntry(route.provider);'),
    'coworkRunner: the pre-gate must consult the exhaustion registry before the turn runs',
  );
  // …and every resume/continue attempt of the same turn stays on the bypass
  // route instead of wandering back to the dead primary.
  const uses = source.match(/quotaBypassOverride/g) ?? [];
  assert.ok(
    uses.length >= 7,
    `coworkRunner: the bypass override must reach the initial attempt AND every in-turn resume site (found ${uses.length} uses, need ≥7: declaration + 6 call sites)`,
  );
});

test('alternative resolvers decline providers the memory already wrote off (shared-balance dead fallback)', () => {
  // 2026-11-19 review P2: when the fallback brain draws the SAME exhausted
  // balance as the primary, both the pre-gate bypass and the GT-02 ladder
  // kept re-picking it — one doomed 429 + one switch notice per turn until
  // the 10-min re-probe. The candidates must be checked against the memory.
  assert.ok(
    source.includes('private isQuotaDeadAlternative(route: DshProviderRouteInfo | null | undefined): boolean {'),
    'coworkRunner: a quota-dead alternative check must exist',
  );
  // Pre-gate bypass: both alternative resolvers run through the check.
  assert.ok(
    source.includes('if (brainFallback && !this.isQuotaDeadAlternative(brainFallback)) {'),
    'coworkRunner: the bypass brain fallback must be declined when quota-dead',
  );
  assert.ok(
    source.includes('if (rescue.route && !this.isQuotaDeadAlternative(rescue.route)) {'),
    'coworkRunner: the bypass rescue/default route must be declined when quota-dead',
  );
  // GT-02 ladder: the avoidance applies on QUOTA deaths only — a config-hard
  // or boot death must keep the plain fallback behavior.
  assert.ok(
    source.includes('if (fallbackRoute && gateQuota && this.isQuotaDeadAlternative(fallbackRoute)) {'),
    'coworkRunner: the GT-02 brain fallback must be declined when quota-dead on a quota gate',
  );
  assert.ok(
    source.includes('fallbackRoute = rescue.route && gateQuota && this.isQuotaDeadAlternative(rescue.route)'),
    'coworkRunner: the GT-02 rescue route must be declined when quota-dead on a quota gate',
  );
});

test('the bypass notice fires once per exhaustion period per session and carries the recharge hint', () => {
  assert.ok(
    source.includes('noticed.sinceMs !== quotaBypassEntry.sinceMs'),
    'coworkRunner: the notice must be keyed to the exhaustion period (a new period re-notifies, the same period stays quiet)',
  );
  assert.ok(
    source.includes('充值积分或在 设置 > 模型 配置自有 Provider'),
    'coworkRunner: the free-relay bypass notice must tell the owner how to recover (top up or configure an own provider)',
  );
  assert.ok(
    source.includes('quotaBypass: true'),
    'coworkRunner: the bypass system message must be machine-identifiable (quotaBypass metadata)',
  );
});

test('quota failures re-mark the dead provider and successful turns clear it', () => {
  assert.ok(
    /if \(isQuotaDshTurnError\(outcome\)\) \{\s*\n\s*this\.markProviderQuotaExhausted\(lastAttemptRoute\.provider\);/.test(source),
    'coworkRunner: a quota outcome must (re)mark the provider that actually served the attempt',
  );
  assert.ok(
    /this\.clearProviderQuotaExhausted\(lastAttemptRoute\.provider\);/.test(source),
    'coworkRunner: a completed turn must clear the memory for the serving provider so a recharge recovers immediately',
  );
  assert.ok(
    source.includes('let lastAttemptRoute = quotaBypassRoute ?? route;'),
    'coworkRunner: the serving-route tracker must seed from the bypass route, or the settlement would blame the dead primary',
  );
});
