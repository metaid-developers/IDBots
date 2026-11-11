// Static wiring checks + behavioral coverage for the unattended-automation
// reasoning-effort policy: machine-driven turns (delegated/scheduled/long-term
// tasks, group tasks, Meta-to-Meta A2A chats, orchestration runs) never
// consult the cerebellum per-message effort selector — their "auto" rung
// resolves straight to the bot edit page's brain pick, else max — while
// human-sent messages (cowork UI chats, IM/Telegram conversations) keep the
// per-message cerebellum classification.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const coworkRunnerSource = readFileSync(join(here, '../src/main/libs/coworkRunner.ts'), 'utf8');

test('the cerebellum effort selector never fires for unattended automation turns', () => {
  // The auto-selector kick must be gated on the unattended classification —
  // machine-driven turns resolve locally and pay no JEV round-trip.
  assert.ok(
    coworkRunnerSource.includes(
      'effectiveEffortRung == null && !unattendedTurn && this.cerebellumEffortSelector',
    ),
    'coworkRunner: the effort selector kick must skip unattended automation sessions',
  );
});

test('the unattended classifier keys off auto-origin, session type, and source channel', () => {
  const classifier = coworkRunnerSource.match(
    /private isUnattendedAutomationSession\(sessionId: string\): boolean \{[\s\S]*?\n  \}/,
  );
  assert.ok(classifier, 'isUnattendedAutomationSession must exist');
  const body = classifier[0];
  assert.ok(
    body.includes('session.autoOrigin'),
    'the classifier must treat auto-created runs (schedule/longterm/orchestration) as unattended',
  );
  assert.ok(
    body.includes("startsWith('im:')"),
    'the classifier must keep human IM conversations (im:<platform>[:direct|:group]) on the interactive path',
  );
  assert.ok(
    body.includes("sessionType ?? 'standard') !== 'standard'"),
    'the classifier must treat non-standard session types (A2A metaweb/browser/group) as unattended',
  );
  assert.ok(
    body.includes("sourceChannel !== 'cowork_ui'"),
    'the classifier must keep cowork UI chats interactive and treat other channels as unattended',
  );
});

test('Studio assistant-mode owner chats are exempt from the unattended classification', () => {
  // 2026-11-11 production forensics: browser-type Studio sessions carrying the
  // assistantMode marker classified unattended, so the cerebellum never fired
  // and every "auto" turn resolved to max (33/33 turns mapped max) — the
  // assistant mode's no-reasoning promise was unreachable for exactly the
  // sessions it was built for. The exemption must sit BEFORE the session-type
  // branch to take effect.
  const classifier = coworkRunnerSource.match(
    /private isUnattendedAutomationSession\(sessionId: string\): boolean \{[\s\S]*?\n  \}/,
  );
  assert.ok(classifier, 'isUnattendedAutomationSession must exist');
  const body = classifier[0];
  const exemptionAt = body.indexOf('this.isAssistantModeOwnerChatSession(sessionId)');
  assert.ok(
    exemptionAt >= 0,
    'the classifier must exempt assistant-mode owner chats from the unattended classification',
  );
  const sessionTypeAt = body.indexOf("sessionType ?? 'standard') !== 'standard'");
  assert.ok(
    sessionTypeAt >= 0 && exemptionAt < sessionTypeAt,
    'the assistant-mode exemption must be checked BEFORE the browser session-type branch',
  );
});

test('both per-turn effort chains route unattended turns through resolveUnattendedAutoEffort', () => {
  // Primary route reads the brain effort, the GT-02 fallback-brain route the
  // fallback brain effort — both must take the unattended branch before the
  // interactive auto rung.
  const unattendedBranches = coworkRunnerSource.match(
    /unattendedTurn\s*\?\s*resolveUnattendedAutoEffort\(\{/g,
  ) ?? [];
  assert.ok(
    unattendedBranches.length >= 2,
    'coworkRunner: primary and fallback effort chains must resolve unattended auto effort locally',
  );
  const brainFeeds = coworkRunnerSource.match(
    /unattendedTurn\s*\?\s*resolveUnattendedAutoEffort\(\{\s*\n\s*brainEffort: automationBrain\?\.(?:effort|fallbackEffort),/g,
  ) ?? [];
  assert.ok(
    brainFeeds.length >= 2,
    'coworkRunner: the unattended branches must feed the primary and fallback brain efforts respectively',
  );
});

test('both per-turn effort chains pin an assistant-mode off verdict to the GLM-expressible floor', () => {
  // A cerebellum 'off' verdict on a GLM route is a lie: the responses/
  // anthropic wires drop an unrepresentable 'off' and the SERVER default
  // thinking level takes over — heavier than 'low'. Both effort chains
  // (primary + fallback-brain resume) must pin the verdict through
  // resolveAssistantModeExpressibleRung, and the fallback-route
  // resolveAutoEffortFallback input must carry the fallback route's GLM
  // family so its no-verdict branch stays honest there too.
  const pins = coworkRunnerSource.match(
    /resolveAssistantModeExpressibleRung\(autoEffortRung, \{ assistantMode, glmFamily: isGlmFamilyModelId\((route|routeOverride)\.model\) \}\)/g,
  ) ?? [];
  assert.ok(
    pins.length >= 2,
    'coworkRunner: primary and fallback effort chains must pin assistant-mode off verdicts for the GLM family',
  );
  const fallbackInput = coworkRunnerSource.match(
    /pinnedFallbackAutoEffortRung \?\? resolveAutoEffortFallback\(\{[\s\S]*?\}\),/,
  );
  assert.ok(fallbackInput, 'the fallback effort chain must keep its resolveAutoEffortFallback call');
  assert.ok(
    fallbackInput[0].includes('glmFamily: isGlmFamilyModelId(routeOverride.model)'),
    'the fallback-route no-verdict fallback must read the fallback model GLM family',
  );
});

// --- behavioral: the pure resolver (compiled runner) ---

test('resolveUnattendedAutoEffort: brain pick first, auto means max, explicit global honored for brain-less bots', async () => {
  const { resolveUnattendedAutoEffort } = await import('../dist-electron/main/libs/coworkRunner.js');
  // THE core policy: a bot pinned in the edit page runs its exact rung on
  // every unattended call — the cerebellum may no longer downgrade it.
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: 'high', hasBrain: true, globalEffort: 'off' }),
    'high',
  );
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: 'max', hasBrain: true, globalEffort: null }),
    'max',
  );
  // A brain left on Auto ('' / null / sentinel token) resolves to max.
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: null, hasBrain: true, globalEffort: 'off' }),
    'max',
  );
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: '', hasBrain: true, globalEffort: null }),
    'max',
  );
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: 'default', hasBrain: true, globalEffort: null }),
    'max',
  );
  // Legacy leftover tokens convert at the read boundary like everywhere else.
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: 'xhigh', hasBrain: true, globalEffort: null }),
    'max',
  );
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: 'medium', hasBrain: true, globalEffort: null }),
    'low',
  );
  // Brain-less sessions honor an explicit persisted global pick...
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: null, hasBrain: false, globalEffort: 'low' }),
    'low',
  );
  // ...and default to max when the global is also auto/unset.
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: null, hasBrain: false, globalEffort: null }),
    'max',
  );
  assert.equal(
    resolveUnattendedAutoEffort({ brainEffort: undefined, hasBrain: false, globalEffort: undefined }),
    'max',
  );
});

// --- behavioral: the assistant-mode GLM floor pin (compiled runner) ---

test('resolveAssistantModeExpressibleRung pins assistant-mode off to low only for the GLM family', async () => {
  const { resolveAssistantModeExpressibleRung } = await import('../dist-electron/main/libs/coworkRunner.js');
  // THE trap this pins shut: assistant mode promises off, GLM-5.x always
  // thinks, and the responses/anthropic wires drop an unrepresentable 'off' —
  // the server default thinking level would run instead, heavier than low.
  assert.equal(
    resolveAssistantModeExpressibleRung('off', { assistantMode: true, glmFamily: true }),
    'low',
  );
  // A non-GLM route can express 'off' — the verdict stands.
  assert.equal(
    resolveAssistantModeExpressibleRung('off', { assistantMode: true, glmFamily: false }),
    'off',
  );
  assert.equal(
    resolveAssistantModeExpressibleRung('off', { assistantMode: true, glmFamily: undefined }),
    'off',
  );
  // Outside assistant mode nothing is pinned (professional off verdicts keep
  // their existing wire-level behavior).
  assert.equal(
    resolveAssistantModeExpressibleRung('off', { assistantMode: false, glmFamily: true }),
    'off',
  );
  // Higher rungs pass through untouched in every combination.
  assert.equal(
    resolveAssistantModeExpressibleRung('low', { assistantMode: true, glmFamily: true }),
    'low',
  );
  assert.equal(
    resolveAssistantModeExpressibleRung('high', { assistantMode: true, glmFamily: true }),
    'high',
  );
  assert.equal(
    resolveAssistantModeExpressibleRung('max', { assistantMode: false, glmFamily: false }),
    'max',
  );
});
