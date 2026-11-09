// Static wiring checks + behavioral coverage for the reasoning-effort
// "Auto"/'default' rung: an explicit pick in a composer/session picker must
// stick in the display and reach the session as the 'default' sentinel
// (auto: cerebellum picks per message; the no-verdict fallback degrades to
// the MODEL DEFAULT, never the bot-brain/global rungs — the compat promise
// for legacy "Default" rows), instead of snapping back to the highest
// fallback tier.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const readSource = (relative) => readFileSync(join(here, relative), 'utf8');

const coworkViewSource = readSource('../src/renderer/components/cowork/CoworkView.tsx');
const botBrowserPanelSource = readSource('../src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');
const sessionDetailSource = readSource('../src/renderer/components/cowork/CoworkSessionDetail.tsx');
const modelCatalogSource = readSource('../src/renderer/services/modelCatalog.ts');
const mainSource = readSource('../src/main/main.ts');
const coworkRunnerSource = readSource('../src/main/libs/coworkRunner.ts');

test('composer pickers keep an explicit Default pick instead of falling through to brain/global', () => {
  // The old `pendingModelEffort?.effort ?? …` chain treated "picked Default"
  // the same as "never picked", so the chip snapped to the highest fallback
  // rung and the choice could not be kept.
  for (const [name, source] of [['CoworkView', coworkViewSource], ['BotBrowserCoworkPanel', botBrowserPanelSource]]) {
    assert.ok(
      !source.includes('pendingModelEffort?.effort'),
      `${name}: display/submit must not conflate an explicit Default pick with a missing pick`,
    );
    assert.ok(
      source.includes('effortDisplayForPick('),
      `${name}: display effort must resolve through effortDisplayForPick`,
    );
    assert.ok(
      source.includes('effortForSessionStart('),
      `${name}: session start must map the pick through effortForSessionStart`,
    );
  }
});

test('session detail picker persists an explicit Default pick as the sentinel', () => {
  assert.ok(
    sessionDetailSource.includes('value.effort ?? LLM_EFFORT_DEFAULT_SENTINEL'),
    'setSessionModel must carry the sentinel for an explicit Default pick',
  );
  assert.ok(
    sessionDetailSource.includes('return convertLegacyEffortLevel(sessionEffortOverride)'),
    'the optimistic override read-back must convert the sentinel to a display level',
  );
});

test('a configured bot brain outranks the persisted global effort', () => {
  // Session start must NOT seed the persisted global effort into
  // effortOverride — that would shadow the bot brain rung for every
  // bot-bound session and pin the UI's "max" onto brains set to Default.
  assert.ok(
    !mainSource.includes(': getPersistedCoworkEffortLevel(),'),
    'main.ts: startSession must leave effort unset when the composer sent no pick',
  );
  // The per-turn runtime gates the global rung on brain absence inside the
  // auto-fallback helper (behavioral coverage below; primary brain and
  // fallback-brain takeover alike route through it).
  const fallbackCalls = coworkRunnerSource.match(/autoEffortRung\s*\?\?\s*resolveAutoEffortFallback\(\{/g) ?? [];
  assert.ok(
    fallbackCalls.length >= 2,
    'coworkRunner: primary and fallback effort chains must resolve the no-verdict fallback through resolveAutoEffortFallback',
  );
  // The composer/session pickers mirror the same rule in the display layer.
  assert.ok(
    coworkViewSource.includes('selectedMetabotBrain?.fallback_llm_id'),
    'CoworkView: the global effort display fallback must be gated on the bot having no configured brain',
  );
  assert.ok(
    sessionDetailSource.includes('sessionMetabot?.fallback_llm_id'),
    'CoworkSessionDetail: the global effort display fallback must be gated on the bot having no configured brain',
  );
});

test('assistant chat-experience mode defaults reasoning off behind the auto rung; a session override wins', () => {
  // Both per-turn chains (primary route and GT-02 fallback-brain route) hoist
  // the explicit session override AHEAD of everything — a user pick in the
  // session picker must stick at runtime. Without an override the cerebellum
  // AUTO rung comes next (autoEffortRung — resolved by the per-turn JEV
  // selector; null hands off to resolveAutoEffortFallback), then assistant
  // mode pins 'off' and skips the bot brain / persisted global / per-model
  // tail (any reasoning pass would delay the first visible token the mode
  // promises). The professional-mode chain stays intact inside the helper.
  // 2026-11-09 surface ruling: assistant mode = the per-session BotHub
  // marker; the effort chain keys on the per-turn GATE, not on any persisted
  // Settings value (the toggle is retired).
  assert.ok(
    coworkRunnerSource.includes('const assistantMode = this.isAssistantModeOwnerChatSession(sessionId);'),
    'coworkRunner: effort resolution must read the per-turn assistant-mode gate (marker-only under the surface ruling)',
  );
  const overrideFirstChains = coworkRunnerSource.match(
    /sessionEffortPicked\s*\?\s*toLlmEffortLevel\(effectiveEffortRung\)\s*:\s*(?:unattendedTurn\s*\?\s*resolveUnattendedAutoEffort\(\{[\s\S]*?\}\)\s*:\s*)?autoEffortRung\s*\?\?/g,
  ) ?? [];
  assert.ok(
    overrideFirstChains.length >= 2,
    'coworkRunner: primary and fallback effort chains must hoist the session override ahead of the auto rung',
  );
  // Both chains must feed the sentinel origin into the fallback — that is
  // what keeps legacy Default rows off the brain/global rung.
  const sentinelFeeds = coworkRunnerSource.match(/sentinelDefault:\s*effortSentinelDefault/g) ?? [];
  assert.ok(
    sentinelFeeds.length >= 2,
    'coworkRunner: primary and fallback chains must pass the sentinel origin into resolveAutoEffortFallback',
  );
});

test('assistant mode displays the Auto rung when the session has no explicit pick', () => {
  // The unpicked display is the Auto rung (null): the turn resolves its effort
  // through the cerebellum auto selector when configured and falls back to the
  // legacy default chain (off in assistant mode) otherwise.
  assert.ok(
    modelCatalogSource.includes('if (options?.assistantMode) return null;'),
    'modelCatalog: effortDisplayForPick must display the Auto rung for a missing pick in assistant mode',
  );
  assert.ok(
    sessionDetailSource.includes('if (isAssistantMode) return null;'),
    'CoworkSessionDetail: the session picker must display the Auto rung in assistant mode when no override exists',
  );
  // The composer display chains must receive the mode flag.
  assert.ok(
    coworkViewSource.includes('{ assistantMode: isAssistantMode }'),
    'CoworkView: the composer display chain must receive the assistant-mode flag',
  );
  assert.ok(
    botBrowserPanelSource.includes('{ assistantMode: isAssistantMode }'),
    'BotBrowserCoworkPanel: the panel display chain must receive the assistant-mode flag',
  );
});

// --- behavioral: sentinel read-boundary compatibility (compiled runner) ---

test('resolveEffectiveEffort distinguishes the sentinel from a plain missing pick', async () => {
  const { resolveEffectiveEffort, resolveEffectiveEffortRung } = await import('../dist-electron/main/libs/coworkRunner.js');
  // The 'default' token (picker "Auto" rung today, legacy "Default" pick on
  // old rows) rides the auto path AND flags its origin for the fallback.
  assert.deepEqual(resolveEffectiveEffort('default'), { rung: null, sentinelDefault: true });
  // A plain null / unknown token is "never picked" — no sentinel origin.
  assert.deepEqual(resolveEffectiveEffort(null), { rung: null, sentinelDefault: false });
  assert.deepEqual(resolveEffectiveEffort(undefined), { rung: null, sentinelDefault: false });
  assert.deepEqual(resolveEffectiveEffort('bogus'), { rung: null, sentinelDefault: false });
  // Explicit rungs stay explicit.
  assert.deepEqual(resolveEffectiveEffort('high'), { rung: 'high', sentinelDefault: false });
  // Legacy export kept for the turn-ack tiering contract.
  assert.equal(resolveEffectiveEffortRung('default'), null);
});

test("resolveAutoEffortFallback keeps legacy Default rows off the bot-brain/global rungs", async () => {
  const { resolveAutoEffortFallback } = await import('../dist-electron/main/libs/coworkRunner.js');
  // THE regression case: a session stored 'default' (legacy explicit Default
  // pick) with a bot brain pinned to 'high' — no verdict may re-inherit the
  // brain effort the pick was created to suppress; it degrades to the model
  // default (null).
  assert.equal(
    resolveAutoEffortFallback({
      sentinelDefault: true, assistantMode: false,
      brainEffort: 'high', hasBrain: true, globalEffort: 'max', modelDefault: 'low',
    }),
    null,
  );
  // Sentinel origin also skips the global and per-model rungs.
  assert.equal(
    resolveAutoEffortFallback({
      sentinelDefault: true, assistantMode: false,
      brainEffort: null, hasBrain: false, globalEffort: 'max', modelDefault: 'low',
    }),
    null,
  );
  // Assistant mode's no-reasoning promise outranks the sentinel origin.
  assert.equal(
    resolveAutoEffortFallback({
      sentinelDefault: true, assistantMode: true,
      brainEffort: 'high', hasBrain: true, globalEffort: 'max', modelDefault: 'low',
    }),
    'off',
  );
  // Plain "never picked" sessions keep the historical chain: brain effort...
  assert.equal(
    resolveAutoEffortFallback({
      sentinelDefault: false, assistantMode: false,
      brainEffort: 'high', hasBrain: true, globalEffort: 'max', modelDefault: 'low',
    }),
    'high',
  );
  // ...a configured brain's null effort means "model default" (the global
  // rung is skipped for brain-bound sessions, the per-model default lands)...
  assert.equal(
    resolveAutoEffortFallback({
      sentinelDefault: false, assistantMode: false,
      brainEffort: null, hasBrain: true, globalEffort: 'max', modelDefault: 'low',
    }),
    'low',
  );
  // ...the global only fills in for brain-less sessions...
  assert.equal(
    resolveAutoEffortFallback({
      sentinelDefault: false, assistantMode: false,
      brainEffort: null, hasBrain: false, globalEffort: 'max', modelDefault: 'low',
    }),
    'max',
  );
  // ...and the per-model default is the last resort.
  assert.equal(
    resolveAutoEffortFallback({
      sentinelDefault: false, assistantMode: false,
      brainEffort: null, hasBrain: false, globalEffort: null, modelDefault: 'low',
    }),
    'low',
  );
});
