import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { defaultBotBrains } from '../src/mobile/app/botDefaults.ts';
import { BotEditorForm, type EditorBrainOption } from '../src/mobile/app/components/BotEditorForm.tsx';
import { mobileI18n, t } from '../src/mobile/i18n.ts';

const options: EditorBrainOption[] = [
  { providerKey: 'zhipu', modelId: 'glm-other', label: 'Zhipu · Other' },
  { providerKey: 'idbots', modelId: 'deepseek-4.1-flash', label: 'ID.Bots · deepseek-flash' },
  { providerKey: 'idbots', modelId: 'glm-5.3-flash', label: 'ID.Bots · GLM-5.3 Flash' },
  { providerKey: 'zhipu', modelId: 'deepseek-flash', label: 'Zhipu · DeepSeek Flash' },
];

function renderCreateForm(): string {
  return renderToStaticMarkup(
    <BotEditorForm
      state={{ bot: null, busy: false, outcome: null }}
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
  const html = renderCreateForm();
  assert.match(html, /data-testid="bot-create-brains"/);
  assert.match(html, /data-testid="bot-model"/);
  assert.match(html, /data-testid="bot-fallback-model"/);
  assert.match(html, /data-testid="bot-effort"/);
  assert.match(html, /data-testid="bot-fallback-effort"/);
  assert.ok(html.includes(`>${t('mobile.me.botEffort.default')}<`));
  assert.equal(t('mobile.me.botEffort.default'), '自动');
  mobileI18n.setLanguage('en');
  assert.equal(t('mobile.me.botEffort.default'), 'Auto');
});
