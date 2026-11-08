import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const appSource = read('src/renderer/App.tsx');
const sidebarSource = read('src/renderer/components/Sidebar.tsx');
const badgeSource = read('src/renderer/components/me/MeBalanceBadge.tsx');
const railSource = read('src/renderer/components/layout/WorkspaceRail.tsx');
const settingsSource = read('src/renderer/components/Settings.tsx');
const planCardSource = read('src/renderer/components/me/IdbotsPlanCard.tsx');

test('ME entry lives in the left rail footer instead of the global top-right corner', () => {
  // Three-column shell (slice 1): the ME entry moved from the old sidebar
  // footer into the icon rail's pinned bottom block — never the global
  // top-right corner, and never inside App's own chrome.
  assert.equal(appSource.includes("import MeBalanceBadge"), false);
  assert.equal(appSource.includes('fixed right-4 top-3'), false);
  assert.match(railSource, /import MeBalanceBadge from '\.\.\/me\/MeBalanceBadge'/);
  assert.match(railSource, /<MeBalanceBadge compact \/>/);
  // The rail renders Settings immediately before ME in that bottom block.
  assert.ok(
    railSource.indexOf('itemId="settings"') < railSource.indexOf('<MeBalanceBadge compact />'),
    'Settings sits above ME in the rail footer',
  );
  // A compact badge opens its panel to the right (a 300 px panel anchored
  // right-0 inside a 64 px column would hang off the window), and the
  // expanded form keeps the historic bottom-right anchor.
  assert.match(badgeSource, /compact \? 'left-0' : 'right-0'/);
  assert.match(badgeSource, /absolute bottom-\[calc\(100%\+8px\)\] z-\[80\][\s\S]*right-0/);
});

test('model settings uses one provider list with TypeSafe JEV as the decision-model destination', () => {
  assert.equal(settingsSource.includes("i18nService.t('modelBrainTab')"), false);
  assert.equal(settingsSource.includes("i18nService.t('modelCerebellumTab')"), false);
  assert.match(settingsSource, /const \[showCerebellumSettings, setShowCerebellumSettings\] = useState\(false\)/);
  assert.match(settingsSource, /setShowProviderTemplatePicker\(false\);\s*setShowCerebellumSettings\(true\);[\s\S]*TypeSafe JEV/);
  assert.match(settingsSource, /onClick=\{\(\) => handleProviderChange\(providerKey\)\}/);
  assert.match(settingsSource, /setShowCerebellumSettings\(false\)/);
});

test('IDBots owns the compact plan card inside its provider details', () => {
  assert.match(settingsSource, /'metaid-free': \{\s*label: 'IDBots'/);
  assert.match(
    settingsSource,
    /activeProvider === LLM_FREE_PROVIDER_KEY[\s\S]*?<IdbotsPlanCard \/>[\s\S]*?<FreeQuotaCard/,
  );
  for (const tier of ['ID.Free', 'ID.Pupil', 'ID.Student', 'ID.Scholar']) {
    assert.ok(planCardSource.includes(tier), `missing tier label ${tier}`);
  }
  assert.match(planCardSource, /mePanelTotal/);
  assert.match(planCardSource, /mePlanThisWeek/);
  assert.match(planCardSource, /mePlanUpgrade/);
  assert.equal(planCardSource.includes('mePlanPriceMonthly'), false);
  assert.equal(planCardSource.includes('mePlanSubscribe'), false);
});

test('IDBots models remain listed without add, edit, delete, or manual sync controls', () => {
  assert.match(
    settingsSource,
    /!isBuiltInFreeProvider\(activeProvider\)[\s\S]*?providerSupportsModelListSync[\s\S]*?handleAddModel/,
  );
  assert.match(
    settingsSource,
    /!isBuiltInFreeProvider\(activeProvider\)[\s\S]*?handleEditModel[\s\S]*?handleDeleteModel/,
  );
  assert.match(
    settingsSource,
    /!isBuiltInFreeProvider\(activeProvider\)[\s\S]*?addFirstModel/,
  );
});
