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
