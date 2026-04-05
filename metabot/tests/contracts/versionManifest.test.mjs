import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createVersionManifest,
  assertVersionManifestCompatibility
} = require('../../dist/core/contracts/versionManifest.js');

test('compatible core and adapter ranges pass', () => {
  const manifest = createVersionManifest('demo-skill-pack', '0.1.0', '^1.0.0', '^2.0.0');
  assert.doesNotThrow(() => {
    assertVersionManifestCompatibility(manifest, {
      coreVersion: '1.4.2',
      adapterVersion: '2.3.1'
    });
  });
});

test('incompatible adapter range is rejected', () => {
  const manifest = createVersionManifest('demo-skill-pack', '0.1.0', '^1.0.0', '^2.0.0');
  assert.throws(() => {
    assertVersionManifestCompatibility(manifest, {
      coreVersion: '1.4.2',
      adapterVersion: '3.0.0'
    });
  });
});

test('incompatible core range is rejected', () => {
  const manifest = createVersionManifest('demo-skill-pack', '0.1.0', '^1.0.0', '^2.0.0');
  assert.throws(() => {
    assertVersionManifestCompatibility(manifest, {
      coreVersion: '2.0.0',
      adapterVersion: '2.3.1'
    });
  });
});
