// Studio demotion of the experimental automation families (owner ruling
// 2026-11-19, Phase 2): the assistant-mode owner chat NEVER mounts the
// playwright-MCP browser family (22 tools, ~18KB) or the cua-driver desktop
// family (58 tools, ~90KB) — the 2026-11-19 census showed 0 Studio calls on
// either while they cost ~27K tokens of every Studio request. The per-bot
// switches stay authoritative for BotWorks/worker/automation surfaces.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(here, '../src/main/main.ts'), 'utf8');

test('session-keyed automation providers decline Studio owner sessions', () => {
  // browserAutomationProvider: undefined on Studio, per-bot switch elsewhere.
  const browserAt = mainSource.indexOf('browserAutomationProvider: (coworkSessionId: string) => {');
  assert.ok(browserAt > 0, 'the browser provider exists');
  const browserBody = mainSource.slice(browserAt, mainSource.indexOf('computerUseProvider:', browserAt));
  assert.ok(
    browserBody.includes('if (getStudioChiefOfStaffService().isStudioOwnerSession(coworkSessionId)) return undefined;'),
    'the browser provider must return undefined (family absent) for Studio owner sessions',
  );
  // computerUseProvider: false on Studio.
  const computerAt = mainSource.indexOf('computerUseProvider: (coworkSessionId: string) => {');
  const computerBody = mainSource.slice(computerAt, mainSource.indexOf('browserAutomationForMetabot:', computerAt));
  assert.ok(
    computerBody.includes('if (getStudioChiefOfStaffService().isStudioOwnerSession(coworkSessionId)) return false;'),
    'the computer provider must return false (family absent) for Studio owner sessions',
  );
});

test('the metabot-keyed prewarm variants keep the raw switches', () => {
  // Intent prewarms fire before any session record exists — they cannot know
  // the surface, so they stay metabot-keyed; the real turn lands on the
  // session-keyed providers and re-slots onto the clean (no-automation)
  // runtime, which is the existing warmup contract.
  const prewarmAt = mainSource.indexOf('browserAutomationForMetabot: (metabotId: number | null)');
  const prewarmBody = mainSource.slice(prewarmAt, mainSource.indexOf('mcpServersForMetabot:', prewarmAt));
  assert.ok(
    prewarmBody.includes('metabotAutomationProviders.browser(metabotId)')
      && prewarmBody.includes('metabotAutomationProviders.computer(metabotId)'),
    'prewarm variants resolve the per-bot switches directly (no surface knowledge yet)',
  );
  assert.ok(
    !prewarmBody.includes('isStudioOwnerSession'),
    'prewarm variants must not pretend to know the session surface',
  );
});

test('the demotion rationale is documented at the gate', () => {
  const gate = mainSource.slice(
    mainSource.indexOf('browserAutomationProvider: (coworkSessionId: string) => {') - 900,
    mainSource.indexOf('browserAutomationProvider: (coworkSessionId: string) => {'),
  );
  assert.ok(
    gate.includes('owner ruling 2026-11-19'),
    'the gate comment must cite the owner ruling and census evidence',
  );
});
