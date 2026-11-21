/**
 * Wiring tests for the explicit default-provider preference
 * (app_config.model.defaultProvider):
 *  - main: resolveMatchedProvider resolves the default model against the
 *    user-chosen provider first, so identical model ids offered by multiple
 *    enabled providers (deepseek + opencode both serving deepseek-v4-flash)
 *    pick the provider the user actually chose — and an explicit metabot
 *    llm_id override is never overridden by it;
 *  - renderer: model selection records the provider key alongside the model
 *    id, and every available-models builder carries it.
 * Style: static source assertions (see coworkBillingSourceWiring.test.mjs).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const rest = source.slice(start + signature.length);
  const nextFn = rest.search(/\nfunction |\nconst |\nexport /);
  return nextFn >= 0 ? rest.slice(0, nextFn) : rest;
}

test('resolveMatchedProvider prefers model.defaultProvider over config-order scan', () => {
  const source = read('src/main/libs/claudeSettings.ts');
  const body = functionBody(source, 'function resolveMatchedProvider(');
  assert.ok(
    body.includes('defaultProviderKey'),
    'resolveMatchedProvider must consult model.defaultProvider'
  );
  assert.ok(
    body.includes("canonicalFreeProviderKey(name) === defaultProviderKey"),
    'the default provider must be matched by canonical key (the free-provider rename made stored labels like "MetaID Free" resolve to the canonical key)'
  );
  // The explicit default-provider preference only applies to global/default
  // sessions — a requestedOverride (metabot llm_id) is a provider choice of
  // its own and must not be overridden.
  assert.ok(
    body.includes('const defaultProviderKey = requestedOverride'),
    'defaultProvider must be skipped when an override is present'
  );
});

test('renderer model selection records the provider key as defaultProvider', () => {
  const appSource = read('src/renderer/App.tsx');
  // The selection effect writes both the model id and the provider key.
  const selectionEffect = appSource.slice(appSource.indexOf('useEffect(() => {\n    if (!isInitialized || !selectedModel?.id) return;'));
  assert.ok(
    selectionEffect.includes('defaultProvider: wantsProvider'),
    'model selection must persist the provider key'
  );
  assert.ok(
    selectionEffect.includes("config.model.defaultProvider === wantsProvider"),
    'provider change alone must trigger a config write'
  );
  // Every available-models builder carries the raw provider key (startup boot
  // and the Settings-close refresh; the onboarding-complete builder was
  // removed with the onboarding wizard).
  const providerKeyOccurrences = (appSource.match(/providerKey: providerName/g) || []).length;
  assert.ok(providerKeyOccurrences >= 2, `App.tsx must attach providerKey in all builders (found ${providerKeyOccurrences})`);
  // Restart safety: the preferred-model selection honors the stored
  // defaultProvider before falling back to the config-order scan.
  assert.ok(
    /\.providerKey === config\.model\.defaultProvider/.test(appSource),
    'preferred model selection must prefer the stored defaultProvider'
  );
});

test('model slice and settings carry providerKey next to the display name', () => {
  const slice = read('src/renderer/store/slices/modelSlice.ts');
  assert.ok(slice.includes('providerKey?: string'), 'Model type must declare providerKey');
  assert.ok(slice.includes('providerKey: providerName'), 'initial model builder must attach providerKey');
  // Restart safety: initial selection and re-matching must keep the stored
  // provider preference instead of jumping to the first same-id model.
  assert.ok(
    slice.includes('model.providerKey === defaultConfig.model.defaultProvider'),
    'initial selectedModel must prefer the stored defaultProvider'
  );
  assert.ok(
    slice.includes('m.providerKey === state.selectedModel.providerKey'),
    'setAvailableModels re-match must keep the current providerKey'
  );
  const settings = read('src/renderer/components/Settings.tsx');
  assert.ok(settings.includes('providerKey: providerName'), 'settings model builder must attach providerKey');
});

test('renderer AppConfig model type admits defaultProvider and normalization preserves it', () => {
  const configSource = read('src/renderer/config.ts');
  assert.ok(configSource.includes('defaultProvider?: string'), 'AppConfig.model must declare defaultProvider');
  assert.ok(
    configSource.includes('...config.model'),
    'normalizeConfig must spread model so defaultProvider survives'
  );
});
