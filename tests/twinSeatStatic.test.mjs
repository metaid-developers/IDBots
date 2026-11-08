import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static wiring guard for the Twin-seat appointment (owner ruling 2026-11-08).
// Behavior is covered by twinSeatAppointment.test.ts (mock IPC) and
// twinSeatChip.test.tsx (render); this file only pins the panel wiring so a
// future refactor cannot quietly drop the delegation, the reload or the toast.

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const panelSource = read('src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');
const chipSource = read('src/renderer/features/botBrowser/TwinSeatChip.tsx');
const helperSource = read('src/renderer/features/botBrowser/twinSeatAppointment.ts');
const i18nSource = read('src/renderer/services/i18n.ts');

test('the panel delegates the Twin swap to the mock-testable helper', () => {
  assert.match(panelSource, /import \{ appointTwinSeat \} from '\.\/twinSeatAppointment';/);
  assert.match(panelSource, /import TwinSeatChip from '\.\/TwinSeatChip';/);
  assert.match(panelSource, /update: \(id, patch\) => window\.electron\.metabot\.update\(id, patch\)/);
  assert.match(panelSource, /reload: loadMetabots/);
  assert.match(panelSource, /notify: notifyTwinSeat/);
  // No inline demote/promote sequence may grow back in the component: the
  // ordering + rollback are the helper's tested contract.
  assert.doesNotMatch(panelSource, /window\.electron\.metabot\.update\(currentTwin\.id/);
  assert.doesNotMatch(panelSource, /metabot_type: 'worker'/);
});

test('the panel surfaces appointment results through the shared toast channel', () => {
  assert.match(panelSource, /new CustomEvent\('app:showToast', \{ detail: message \}\)/);
  assert.match(panelSource, /if \(twinSeatBusy\) return;/);
  assert.match(panelSource, /<TwinSeatChip/);
  assert.match(panelSource, /live=\{Boolean\(currentSession\)\}/);
  assert.match(panelSource, /menuOpen=\{showTwinSeatMenu\}/);
});

test('the helper keeps demote-before-promote and a rollback leg', () => {
  const demote = helperSource.indexOf("metabot_type: 'worker'");
  const promote = helperSource.indexOf("metabot_type: 'twin'");
  assert.ok(demote >= 0, 'the demote leg must exist');
  assert.ok(promote > demote, 'demote must precede promote');
  assert.match(helperSource, /rollbackAttempted = true/);
  assert.match(helperSource, /botInternetTwinSeatAppointed/);
});

test('the chip renders menu rows from the roster and keeps live sessions read-only', () => {
  assert.match(chipSource, /\{roster\.map\(\(metabot\) => \{/);
  assert.match(chipSource, /disabled=\{busy \|\| isActing\}/);
  assert.match(chipSource, /\{isActing && <TwinBadge className="shrink-0" \/>\}/);
  assert.match(chipSource, /live \? \(/);
});

test('the Twin-seat copy exists in both locales', () => {
  for (const key of [
    'botInternetTwinSeatTitle',
    'botInternetTwinSeatHint',
    'botInternetTwinSeatChip',
    'botInternetTwinSeatAppointed',
    'botInternetTwinSeatRollbackFailed',
  ]) {
    const occurrences = i18nSource.match(new RegExp(`${key}:`, 'g')) ?? [];
    assert.equal(occurrences.length, 2, `${key} must exist in zh and en`);
  }
});
