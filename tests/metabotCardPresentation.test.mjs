import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildMetaBotToggleViewModel,
  copyGlobalMetaIdToClipboard,
  formatGlobalMetaIdShort,
} = await import('../src/renderer/components/metabots/metaBotCardPresentation.js');

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

test('global meta id display uses first 6 characters and last 4 characters', () => {
  assert.equal(formatGlobalMetaIdShort('idq14habcdefg9xz'), 'idq14h....g9xz');
  assert.equal(formatGlobalMetaIdShort('idq1234567890abcd'), 'idq123....abcd');
});

test('copy global meta id helper writes the full trimmed id to clipboard', async () => {
  const writes = [];
  const didCopy = await copyGlobalMetaIdToClipboard('  idq14habcdefg9xz  ', {
    async writeText(value) {
      writes.push(value);
    },
  });

  assert.equal(didCopy, true);
  assert.deepEqual(writes, ['idq14habcdefg9xz']);
});
