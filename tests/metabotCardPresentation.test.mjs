import test from 'node:test';
import assert from 'node:assert/strict';

const { buildMetaBotToggleViewModel } = await import('../src/renderer/components/metabots/metaBotCardPresentation.js');

test('metabot enable toggle uses standard dimensions and accent color when enabled', () => {
  const toggle = buildMetaBotToggleViewModel({ enabled: true });

  assert.match(toggle.trackClass, /\bw-9\b/);
  assert.match(toggle.trackClass, /\bh-5\b/);
  assert.match(toggle.trackClass, /\bbg-claude-accent\b/);
  assert.match(toggle.knobClass, /translate-x-\[18px\]/);
});

test('metabot enable toggle uses standard off position when disabled', () => {
  const toggle = buildMetaBotToggleViewModel({ enabled: false });

  assert.match(toggle.trackClass, /\bbg-claude-border\b/);
  assert.match(toggle.knobClass, /translate-x-\[3px\]/);
});
