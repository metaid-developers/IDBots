// Settings > Models rework (ZCode-style add-provider flow):
// 1. The provider template catalog ported from ZCode stays well-formed and
//    every logo key has its asset on disk.
// 2. The Settings source keeps the layout + visibility anchors: slimmed nav,
//    fixed-width provider column, the two pinned ID.Bots entries and the
//    template picker wiring.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVIDER_TEMPLATES } from '../src/renderer/services/providerTemplates';
import { defaultConfig } from '../src/renderer/config';


const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments: string[]) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

test('provider template catalog is well-formed', () => {
  assert.ok(PROVIDER_TEMPLATES.length >= 30, `expected the full ZCode catalog, got ${PROVIDER_TEMPLATES.length}`);
  const ids = new Set<string>();
  for (const template of PROVIDER_TEMPLATES) {
    assert.ok(!ids.has(template.templateId), `duplicate templateId ${template.templateId}`);
    ids.add(template.templateId);
    assert.ok(template.nameZh && template.nameEn, `${template.templateId}: missing display name`);
    assert.ok(
      template.apiFormat === 'anthropic' || template.apiFormat === 'openai' || template.apiFormat === 'responses',
      `${template.templateId}: bad apiFormat`,
    );
    assert.match(template.baseUrl, /^https?:\/\//, `${template.templateId}: bad baseUrl`);
    assert.ok(template.models.length > 0, `${template.templateId}: no preset models`);
    const modelIds = new Set<string>();
    for (const model of template.models) {
      assert.ok(!modelIds.has(model.id), `${template.templateId}: duplicate model ${model.id}`);
      modelIds.add(model.id);
      if (model.contextWindow !== undefined) {
        assert.ok(model.contextWindow > 0, `${template.templateId}/${model.id}: bad contextWindow`);
      }
      if (model.maxOutputTokens !== undefined) {
        assert.ok(model.maxOutputTokens > 0, `${template.templateId}/${model.id}: bad maxOutputTokens`);
      }
    }
  }
  // The Zhipu-family entries ride the flat list (no separate picker group).
  for (const zhipuId of ['zai-api', 'zai-standard-api', 'bigmodel-api', 'bigmodel-standard-api']) {
    assert.ok(ids.has(zhipuId), `missing Zhipu-family template ${zhipuId}`);
  }
});

test('every template logo key resolves to an asset on disk', () => {
  const assetDir = path.join(projectRoot, 'src', 'renderer', 'assets', 'providers');
  const assets = new Set(fs.readdirSync(assetDir));
  for (const template of PROVIDER_TEMPLATES) {
    const hit = [
      `${template.logo}.png`,
      `${template.logo}.svg`,
      `${template.logo}-light.svg`,
    ].some((name) => assets.has(name));
    assert.ok(hit, `${template.templateId}: no asset for logo key ${template.logo}`);
  }
});

test('models settings page keeps the new layout and visibility anchors', () => {
  const settings = readSource('src', 'renderer', 'components', 'Settings.tsx');

  // Settings shell: left nav slimmed ~1/5 (220px → 176px).
  assert.match(settings, /w-\[176px\] shrink-0 flex flex-col min-h-0/);
  assert.equal(settings.includes('w-[220px]'), false);

  // Models tab: provider column pinned to a fixed width, detail pane flexes.
  assert.match(settings, /w-\[272px\] shrink-0 border-r/);
  assert.match(settings, /flex-1 min-w-0 pl-4 overflow-y-auto/);
  assert.equal(settings.includes('w-2/5 border-r'), false);
  assert.equal(settings.includes('w-3/5 pl-4'), false);

  // The ID.Bots top-up pseudo-entry + placeholder detail pane.
  assert.match(settings, /IDBOTS_RECHARGE_PROVIDER_KEY = 'idbots-recharge' as ProviderType/);
  assert.match(settings, /idbotsRechargePlaceholder/);

  // Subscription entry is always visible; untouched built-ins stay hidden.
  assert.match(settings, /!isTouched && !isBuiltInFreeProvider\(key\)/);

  // The template picker replaces the old add-provider modal.
  assert.match(settings, /<ProviderTemplatePicker/);
  assert.match(settings, /handleCreateProviderFromTemplate/);
  assert.match(settings, /handleCreateCustomProviderInstant/);
  assert.equal(settings.includes('isAddingCustomProvider'), false);

  // Template picks carry their vendor logo so the left list + detail header
  // render the real icon (user-created customs keep the generic one).
  assert.match(settings, /logoKey: template\.logo/);
  assert.match(settings, /getProviderIconWithLogo\(providerKey, config, isDarkTheme\)/);
  assert.match(settings, /getProviderIconWithLogo\(activeProvider, providers\[activeProvider\], isDarkTheme\)/);

  // The third-party group label only renders when the group is non-empty.
  assert.match(settings, /thirdPartyProviderEntries\.length > 0/);
  assert.match(settings, /i18nService\.t\('thirdPartyProviders'\)/);

  // The ME-rates footer note is subscription-only.
  assert.match(
    settings,
    /activeProvider === LLM_FREE_PROVIDER_KEY && \(\s*<p className="mt-2 text-\[10px\] leading-relaxed[^>]*>\s*\{i18nService\.t\('meRatesFooterNote'\)\}/,
  );

  // Provider deletion goes through the in-app confirm dialog — window.confirm
  // is a silent no-op in Electron and made the trash button dead.
  assert.match(settings, /pendingDeleteProvider, setPendingDeleteProvider\] = useState/);
  assert.match(settings, /onClick=\{\(\) => setPendingDeleteProvider\(activeProvider\)\}/);
  assert.equal(/\bwindow\.confirm\(/.test(settings), false);
});

test('template catalog and default config stay disjoint from the free provider', () => {
  // The subscription relay keeps its own key; templates must never shadow it.
  for (const template of PROVIDER_TEMPLATES) {
    assert.notEqual(template.templateId, 'metaid-free');
    assert.match(template.baseUrl, /^https:/, `${template.templateId}: template base URLs must be https`);
  }
  // And the app still boots with the full built-in provider registry.
  for (const key of ['metaid-free', 'deepseek', 'opencode', 'commandcode', 'zhipu']) {
    assert.ok((defaultConfig.providers as Record<string, unknown>)[key], `missing built-in provider ${key}`);
  }
});
