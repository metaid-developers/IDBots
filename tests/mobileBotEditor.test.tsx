import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { defaultBotBrains } from '../src/mobile/app/botDefaults.ts';
import { BotEditorForm, type EditorBrainOption } from '../src/mobile/app/components/BotEditorForm.tsx';
import { mobileI18n, t } from '../src/mobile/i18n.ts';
import { BUILTIN_AVATARS } from '../src/renderer/assets/builtinAvatarCatalog.ts';
import type { MobileMetabot } from '../src/mobile/bridge/types.ts';

const options: EditorBrainOption[] = [
  { providerKey: 'zhipu', modelId: 'glm-other', label: 'Zhipu · Other' },
  { providerKey: 'idbots', modelId: 'deepseek-4.1-flash', label: 'ID.Bots · deepseek-flash' },
  { providerKey: 'idbots', modelId: 'glm-5.3-flash', label: 'ID.Bots · GLM-5.3 Flash' },
  { providerKey: 'zhipu', modelId: 'deepseek-flash', label: 'Zhipu · DeepSeek Flash' },
];

function renderForm(bot: MobileMetabot | null = null): string {
  return renderToStaticMarkup(
    <BotEditorForm
      state={{ bot, busy: false, outcome: null }}
      brainOptions={options}
      skills={[]}
      catalogError={null}
      getBalance={async () => ({ success: true, value: '0 MVC' })}
      onSave={async () => undefined}
      onClose={() => undefined}
    />,
  );
}

test('create defaults prefer ID.Bots DeepSeek flash and GLM-5.3 Flash, not catalog order', () => {
  const defaults = defaultBotBrains(options);
  assert.equal(defaults.primary?.providerKey, 'idbots');
  assert.equal(defaults.primary?.modelId, 'deepseek-4.1-flash');
  assert.equal(defaults.fallback?.providerKey, 'idbots');
  assert.equal(defaults.fallback?.modelId, 'glm-5.3-flash');
  assert.deepEqual(defaultBotBrains([]), { primary: null, fallback: null });
});

test('create form exposes primary and fallback selectors with Auto effort defaults', () => {
  mobileI18n.setLanguage('zh');
  const html = renderForm();
  assert.match(html, /data-testid="bot-create-brains"/);
  assert.match(html, /data-testid="bot-model"/);
  assert.match(html, /data-testid="bot-fallback-model"/);
  assert.match(html, /data-testid="bot-effort"/);
  assert.match(html, /data-testid="bot-fallback-effort"/);
  assert.match(html, /<option value="idbots\ndeepseek-4\.1-flash" selected="">/);
  assert.match(html, /<option value="idbots\nglm-5\.3-flash" selected="">/);
  assert.ok(html.includes(`>${t('mobile.me.botEffort.default')}<`));
  assert.equal(t('mobile.me.botEffort.default'), '自动');
  mobileI18n.setLanguage('en');
  assert.equal(t('mobile.me.botEffort.default'), 'Auto');
});


test('mobile avatar settings enable the same 20 built-in avatars as desktop', () => {
  const source = readFileSync(new URL('../src/mobile/app/components/BotEditorForm.tsx', import.meta.url), 'utf8');
  assert.match(source, /AvatarPickerModal/);
  assert.match(source, /allowBuiltin=\{true\}/);
  assert.equal(BUILTIN_AVATARS.length, 20);
  for (const avatar of BUILTIN_AVATARS) {
    assert.ok(existsSync(new URL(`../public/${avatar.src}`, import.meta.url)), avatar.src);
  }
});

test('Twin badge appears in the editor and both Bot list implementations use it', () => {
  const twin = {
    id: 1,
    name: 'Twin Bot',
    metabot_type: 'twin',
    llm_id: 'deepseek-flash',
    llm_provider: 'idbots',
  } as MobileMetabot;
  const html = renderForm(twin);
  assert.match(html, /data-testid="bot-editor-twin"/);
  assert.match(html, /data-testid="bot-twin-badge">Twin<\/span>/);
  for (const path of [
    '../src/mobile/app/screens/me/BotsPage.tsx',
    '../src/mobile/app/components/BotManagementSection.tsx',
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /<TwinBadge \/>/);
  }
});
