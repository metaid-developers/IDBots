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
const settingsSource = read('src/renderer/components/Settings.tsx');
const planCardSource = read('src/renderer/components/me/IdbotsPlanCard.tsx');

test('ME entry lives in the sidebar footer instead of the global top-right corner', () => {
  assert.equal(appSource.includes("import MeBalanceBadge"), false);
  assert.equal(appSource.includes('fixed right-4 top-3'), false);
  assert.match(sidebarSource, /import MeBalanceBadge from '\.\/me\/MeBalanceBadge'/);
  assert.match(sidebarSource, /ml-auto flex items-center gap-2[\s\S]*<MeBalanceBadge \/>/);
  assert.match(badgeSource, /absolute bottom-\[calc\(100%\+8px\)\] right-0/);
});

test('model settings uses one provider list with TypeSafe JEV as the decision-model destination', () => {
  assert.equal(settingsSource.includes("i18nService.t('modelBrainTab')"), false);
  assert.equal(settingsSource.includes("i18nService.t('modelCerebellumTab')"), false);
  assert.match(settingsSource, /const \[showCerebellumSettings, setShowCerebellumSettings\] = useState\(false\)/);
  assert.match(settingsSource, /onClick=\{\(\) => setShowCerebellumSettings\(true\)\}[\s\S]*TypeSafe JEV/);
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
