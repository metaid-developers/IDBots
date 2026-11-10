import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static wiring guard for the Studio footer bot picker (owner ruling
// 2026-11-11). Behavior is covered by botPickerChip.test.tsx (render); this
// file pins the panel wiring so a refactor cannot quietly grow the picker
// back into a Twin appointment: picking a bot is a PURE selection — the only
// place that writes metabot_type is the My Bots editor.

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const panelSource = read('src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');
const chipSource = read('src/renderer/features/botBrowser/BotPickerChip.tsx');
const dismissSource = read('src/renderer/features/botBrowser/seatMenuDismiss.ts');
const resolverSource = read('src/renderer/services/coworkSessionStart.ts');
const managerSource = read('src/renderer/components/metabots/MetabotsManager.tsx');
const i18nSource = read('src/renderer/services/i18n.ts');

test('the panel renders the picker chip and resolves the draft target like BotWorks', () => {
  assert.match(panelSource, /import BotPickerChip from '\.\/BotPickerChip';/);
  assert.match(panelSource, /import \{ resolveDefaultMetabotId \} from '\.\.\/\.\.\/services\/coworkSessionStart';/);
  // Same resolution as the BotWorks new-task composer: explicit pick wins,
  // else the Twin, else the first bot.
  assert.match(panelSource, /resolveDefaultMetabotId\(metabots, pickedMetabotId\)/);
  assert.match(resolverSource, /const twin = bots\.find\(\(bot\) => bot\.metabot_type === 'twin'\);/);
  assert.match(panelSource, /<BotPickerChip/);
  assert.match(panelSource, /live=\{Boolean\(currentSession\)\}/);
  assert.match(panelSource, /menuOpen=\{showBotPickerMenu\}/);
});

test('picking a bot is a pure selection: no metabot_type write, no IPC, no toast', () => {
  assert.match(panelSource, /const handlePickBot = useCallback\(\(target: PanelMetabot\) => \{/);
  assert.match(panelSource, /setPickedMetabotId\(target\.id\);/);
  assert.match(panelSource, /setShowBotPickerMenu\(false\);/);
  // The appointment machinery must never grow back into the picker: metabot
  // updates belong to the My Bots editor alone.
  assert.doesNotMatch(panelSource, /appointTwinSeat/);
  assert.doesNotMatch(panelSource, /window\.electron\.metabot\.update/);
  assert.doesNotMatch(panelSource, /metabot_type: 'worker'/);
  assert.doesNotMatch(panelSource, /metabot_type: 'twin'/);
  // A selection needs no toast either — silence is the success path.
  assert.doesNotMatch(panelSource, /app:showToast/);
});

test('the chip menu lists the roster with every row enabled and keeps live read-only', () => {
  assert.match(chipSource, /\{roster\.map\(\(metabot\) => \(/);
  assert.doesNotMatch(chipSource, /disabled=\{/, 'a pure selection never disables a roster row');
  assert.match(chipSource, /aria-selected=\{isSelected\}/);
  assert.match(chipSource, /live \? \(/);
});

test('an open picker menu closes on an outside pointer through the tested helper', () => {
  assert.match(chipSource, /import \{ bindSeatMenuOutsideDismiss \} from '\.\/seatMenuDismiss';/);
  assert.match(chipSource, /if \(!menuOpen\) return undefined;/);
  assert.match(chipSource, /container: \(\) => containerRef\.current/);
  assert.match(chipSource, /onDismiss: onDismissMenu/);
  assert.match(chipSource, /ref=\{containerRef\}/);
  assert.match(panelSource, /onDismissMenu=\{closeBotPickerMenu\}/);
  // Capture phase: a row that stops propagation cannot pin the menu open.
  assert.match(dismissSource, /addEventListener\('pointerdown', handlePointerDown, true\)/);
});

test('My Bots subscribes to the shared broadcast and refetches silently', () => {
  assert.match(
    managerSource,
    /import \{ dispatchMetabotsChanged, subscribeMetabotsChanged \} from '\.\.\/\.\.\/services\/metabotEvents';/,
  );
  assert.match(managerSource, /useEffect\(\(\) => subscribeMetabotsChanged/);
  assert.match(managerSource, /void loadList\(\{ silent: true \}\)/);
  assert.match(managerSource, /dispatchMetabotsChanged\(\{ metabotIds: \[editId\], reason: 'edit' \}\)/);
});

test('the picker copy exists in both locales and the appointment copy is gone', () => {
  for (const key of [
    'botInternetBotPickerTitle',
    'botInternetBotPickerHint',
    'botInternetBotPickerChip',
    'botBrowserCoworkPlaceholderWorker',
    'botBrowserCoworkEmptySubWorker',
    'botInternetNeedsBot',
    'botInternetGoBotWorks',
  ]) {
    const occurrences = i18nSource.match(new RegExp(`${key}:`, 'g')) ?? [];
    assert.equal(occurrences.length, 2, `${key} must exist in zh and en`);
  }
  for (const key of [
    'botInternetTwinSeatTitle',
    'botInternetTwinSeatHint',
    'botInternetTwinSeatAppoint',
    'botInternetTwinSeatChip',
    'botInternetTwinSeatAppointed',
    'botInternetTwinSeatRollbackFailed',
    'botInternetNeedsTwin',
    'botInternetGoBotHome',
  ]) {
    const occurrences = i18nSource.match(new RegExp(`${key}:`, 'g')) ?? [];
    assert.equal(occurrences.length, 0, `${key} must be gone — the seat appointment is retired`);
  }
});
