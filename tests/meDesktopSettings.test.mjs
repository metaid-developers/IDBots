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
const i18nSource = read('src/renderer/services/i18n.ts');

test('ME entry lives in the sidebar footer instead of the global top-right corner', () => {
  assert.equal(appSource.includes("import MeBalanceBadge"), false);
  assert.equal(appSource.includes('fixed right-4 top-3'), false);
  assert.match(sidebarSource, /import MeBalanceBadge from '\.\/me\/MeBalanceBadge'/);
  assert.match(sidebarSource, /ml-auto flex items-center gap-2[\s\S]*<MeBalanceBadge \/>/);
  assert.match(badgeSource, /placePopoverAbove\(/);
  assert.match(badgeSource, /className="fixed z-\[80\]/);
  assert.equal(badgeSource.includes('absolute bottom-[calc(100%+8px)] right-0'), false);
});

test('model settings places Cerebellum in the ID.Bots subscription group', () => {
  assert.equal(settingsSource.includes("i18nService.t('modelBrainTab')"), false);
  assert.match(settingsSource, /const \[showCerebellumSettings, setShowCerebellumSettings\] = useState\(false\)/);
  const idbotsIndex = settingsSource.indexOf('{providers[LLM_FREE_PROVIDER_KEY] && renderProviderRow');
  const cerebellumIndex = settingsSource.indexOf("{i18nService.t('modelCerebellumTab')}", idbotsIndex);
  const thirdPartyIndex = settingsSource.indexOf("{i18nService.t('thirdPartyProviders')}", cerebellumIndex);
  assert.ok(idbotsIndex >= 0, 'ID.Bots subscription row should exist');
  assert.ok(cerebellumIndex > idbotsIndex, 'Cerebellum should follow the ID.Bots subscription row');
  assert.ok(thirdPartyIndex > cerebellumIndex, 'Cerebellum should precede the third-party group label');
  assert.match(settingsSource, /\{ value: 'idbots-jev-free', label: 'IDBots-JEV' \}/);
  assert.match(settingsSource, /setShowProviderTemplatePicker\(false\);\s*setShowCerebellumSettings\(true\)/);
  assert.match(settingsSource, /onClick=\{\(\) => handleProviderChange\(providerKey\)\}/);
  assert.match(settingsSource, /setShowCerebellumSettings\(false\)/);
});

test('the list and detail cerebellum switches share state and the saved config', () => {
  const toggles = settingsSource.match(/onClick=\{\(\) => handleCerebellumConfigChange\('enabled', !cerebellum.enabled\)\}/g) ?? [];
  assert.equal(toggles.length, 2);
  assert.equal((settingsSource.match(/aria-checked=\{cerebellum.enabled\}/g) ?? []).length, 2);
  assert.match(settingsSource, /providers: normalizedProviders,[\s\S]*?cerebellum,/);
});

test('cerebellum copy names IDBots-JEV and explains ME credit billing and provider choice', () => {
  assert.ok(i18nSource.includes('IDBots-JEV 是 IDBots 官方的小脑模型，使用IDBots-JEV小脑功能将消耗积分。用量情况可在「积分&流量」页查看。'));
  assert.ok(i18nSource.includes('你可以选择小脑服务商为 ID.Bots提供的小脑模型，也可以使用 TypeSafe 的 JEV模型'));
  assert.equal(i18nSource.includes('IDBots-JEV-Free 是 IDBots 官方的免费小脑服务'), false);
  assert.match(settingsSource, /i18nService\.t\('cerebellumIdbotsProviderHint'\)/);
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
