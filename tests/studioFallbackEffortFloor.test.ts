// In-turn effort floor for GT-02 fallback attempts (2026-11-19 Studio
// long-session post-mortem): the primary attempt of a turn pins the effort
// level it started with (e.g. a cerebellum 'off' verdict raised to 'low'
// because the primary route was GLM-family and cannot express 'off'). A
// fallback onto a model that CAN express 'off' must not silently drop the
// remainder of the turn back down — the incident session ran 16 consecutive
// quota-fallback turns as deepseek-flash 'off' while the owner believed they
// were talking to glm-5.3-flash 'low'.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { maxLlmEffortLevel, effortLevelRank } from '../src/main/libs/llmEffort';
import { mapDshReasoningEffort } from '../src/main/libs/dshReasoningEffort';

const here = dirname(fileURLToPath(import.meta.url));
const coworkRunnerSource = readFileSync(join(here, '../src/main/libs/coworkRunner.ts'), 'utf8');

test('maxLlmEffortLevel orders the ladder and treats null as no-say', () => {
  assert.equal(maxLlmEffortLevel('low', 'off'), 'low');
  assert.equal(maxLlmEffortLevel('off', 'low'), 'low');
  assert.equal(maxLlmEffortLevel('high', 'max'), 'max');
  assert.equal(maxLlmEffortLevel('max', 'max'), 'max');
  // null loses to any concrete level on either side; null vs null stays null.
  assert.equal(maxLlmEffortLevel(null, 'off'), 'off');
  assert.equal(maxLlmEffortLevel('high', null), 'high');
  assert.equal(maxLlmEffortLevel(null, null), null);
});

test('effortLevelRank orders off < low < high < max with null lowest', () => {
  assert.ok(effortLevelRank('off') < effortLevelRank('low'));
  assert.ok(effortLevelRank('low') < effortLevelRank('high'));
  assert.ok(effortLevelRank('high') < effortLevelRank('max'));
  assert.ok(effortLevelRank(null) < effortLevelRank('off'));
});

test('a floored low survives both wire dialects unchanged', () => {
  // The incident path: deepseek-native mapped 'off'; the floor must land as
  // 'low' on BOTH dialects, never collapse back to 'off'.
  assert.equal(mapDshReasoningEffort('low', undefined, 'deepseek-native'), 'low');
  assert.equal(mapDshReasoningEffort('low', undefined, 'generic'), 'low');
  assert.equal(mapDshReasoningEffort('low', { type: 'disabled' }, 'deepseek-native'), 'off');
});

test('coworkRunner holds the primary attempt effort as the in-turn fallback floor', () => {
  // The primary attempt's pre-mapping level is hoisted…
  assert.ok(
    coworkRunnerSource.includes('const primaryEffortLevel: LlmEffortLevel | null'),
    'coworkRunner: the primary attempt effort level must be hoisted for the fallback floor',
  );
  // …and the GT-02 routeOverride clamps the fallback level up to it…
  assert.ok(
    coworkRunnerSource.includes('maxLlmEffortLevel(fallbackEffortLevel, primaryEffortLevel)'),
    'coworkRunner: the fallback attempt effort must be clamped to the in-turn floor',
  );
  // …but ONLY for assistant/mobile owner chat: bot-automation turns keep the
  // fallback brain's own configured effort (deliberate bot config), and an
  // explicit session pick already pins both attempts identically.
  const gate = coworkRunnerSource.match(
    /const flooredFallbackEffortLevel = ([^\n]+)\n/,
  );
  assert.ok(gate, 'coworkRunner: the floor clamp must be a named, greppable statement');
  assert.ok(
    gate[1].includes('fastOwnerChatMode && !unattendedTurn && !sessionEffortPicked'),
    `coworkRunner: the floor gate must be assistant/mobile owner chat only (got: ${gate[1]})`,
  );
});
