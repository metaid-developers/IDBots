import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  createVersionManifest,
  assertVersionManifestCompatibility
} = require('../../dist/core/contracts/versionManifest.js');

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const COMPATIBILITY_MANIFEST_PATH = path.join(REPO_ROOT, 'metabot/release/compatibility.json');

async function loadCompatibilityManifest() {
  return JSON.parse(await readFile(COMPATIBILITY_MANIFEST_PATH, 'utf8'));
}

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

test('caret ranges with 0.x reject next minor', () => {
  const manifest = createVersionManifest('demo-skill-pack', '0.1.0', '^0.1.0', '^0.1.0');
  assert.throws(() => {
    assertVersionManifestCompatibility(manifest, {
      coreVersion: '0.2.0',
      adapterVersion: '0.1.4'
    });
  });
  assert.throws(() => {
    assertVersionManifestCompatibility(manifest, {
      coreVersion: '0.1.4',
      adapterVersion: '0.2.0'
    });
  });
});

test('caret ranges with 0.x allow same minor', () => {
  const manifest = createVersionManifest('demo-skill-pack', '0.1.0', '^0.1.0', '^0.1.0');
  assert.doesNotThrow(() => {
    assertVersionManifestCompatibility(manifest, {
      coreVersion: '0.1.9',
      adapterVersion: '0.1.2'
    });
  });
});

test('compatibility manifest rejects doctor when CLI/core versions drift', async () => {
  const compatibility = await loadCompatibilityManifest();
  const doctorManifest = createVersionManifest(
    'metabot-doctor',
    compatibility.cli,
    compatibility.core,
    compatibility.cli
  );

  assert.throws(() => {
    assertVersionManifestCompatibility(doctorManifest, {
      coreVersion: '0.2.0',
      adapterVersion: compatibility.cli,
    });
  });

  assert.throws(() => {
    assertVersionManifestCompatibility(doctorManifest, {
      coreVersion: compatibility.core,
      adapterVersion: '0.2.0',
    });
  });
});

test('compatibility manifest rejects skill-pack install when host pack version drifts', async () => {
  const compatibility = await loadCompatibilityManifest();

  for (const [host, version] of Object.entries(compatibility.skillpacks)) {
    const installManifest = createVersionManifest(
      `metabot-skillpack-${host}`,
      String(version),
      compatibility.cli,
      String(version)
    );

    assert.throws(() => {
      assertVersionManifestCompatibility(installManifest, {
        coreVersion: compatibility.cli,
        adapterVersion: '0.2.0',
      });
    });
  }
});

test('compatibility manifest accepts all three released host packs when versions match', async () => {
  const compatibility = await loadCompatibilityManifest();

  for (const [host, version] of Object.entries(compatibility.skillpacks)) {
    const installManifest = createVersionManifest(
      `metabot-skillpack-${host}`,
      String(version),
      compatibility.cli,
      String(version)
    );

    assert.doesNotThrow(() => {
      assertVersionManifestCompatibility(installManifest, {
        coreVersion: compatibility.cli,
        adapterVersion: String(version),
      });
    });
  }
});
