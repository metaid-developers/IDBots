import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

// Pins the Agent Browser Core v0.10.2 integration contract: the four direct
// ABC dependencies move together, the allow-forms sandbox patch is re-issued
// against the 0.10.2 package (never a mechanical key rename), the installed
// tree actually carries the patched renderer, and the unrelated third-party
// abitype@0.10.0 pin is left alone.

const rootUrl = new URL('..', import.meta.url);

const readJson = (relativePath) =>
  JSON.parse(readFileSync(new URL(relativePath, rootUrl), 'utf8'));
const readText = (relativePath) => readFileSync(new URL(relativePath, rootUrl), 'utf8');

const ABC_DIRECT_DEPS = [
  '@openagentinternet/agent-browser-core',
  '@openagentinternet/agent-browser-host-contract',
  '@openagentinternet/agent-browser-name-resolvers',
  '@openagentinternet/agent-browser-ui',
];
const ABC_ALL_PACKAGES = [
  ...ABC_DIRECT_DEPS,
  '@openagentinternet/agent-browser-renderers',
];
const PATCHED_UI_PACKAGE = '@openagentinternet/agent-browser-ui';
const PATCH_KEY = `${PATCHED_UI_PACKAGE}@0.10.2`;

test('all four direct ABC dependencies pin 0.10.2 in package.json', () => {
  const manifest = readJson('package.json');
  for (const name of ABC_DIRECT_DEPS) {
    assert.equal(manifest.dependencies?.[name], '0.10.2', `${name} must pin 0.10.2`);
  }
});

test('minimumReleaseAgeExclude lists 0.10.2 for every ABC package', () => {
  const workspaceYaml = readText('pnpm-workspace.yaml');
  for (const name of ABC_ALL_PACKAGES) {
    const entry = workspaceYaml
      .split('\n')
      .find((line) => line.trim().startsWith(`- '${name}@`));
    assert.ok(entry, `minimumReleaseAgeExclude must keep an entry for ${name}`);
    assert.ok(
      entry.includes('0.10.2'),
      `${name} exclusion expression must include 0.10.2`,
    );
  }
});

test('patchedDependencies re-issues the allow-forms patch against 0.10.2', () => {
  const workspaceYaml = readText('pnpm-workspace.yaml');
  // pnpm patch-commit may serialize the mapping in block or flow style, so
  // extract the patch path with a regex instead of line layout assumptions.
  const patchEntry = workspaceYaml.match(
    new RegExp(`'${PATCH_KEY.replace('.', '\\.')}':\\s*(patches/[^'\\s}]+)`),
  );
  assert.ok(patchEntry, `patchedDependencies must key ${PATCH_KEY}`);
  assert.ok(
    !/agent-browser-ui@0\.10\.1/.test(workspaceYaml),
    'the stale 0.10.1 patchedDependencies key must be gone',
  );
  assert.ok(
    !/agent-browser-ui@0\.10\.0/.test(workspaceYaml),
    'the stale 0.10.0 patchedDependencies key must be gone',
  );

  const patchFile = patchEntry[1];
  assert.ok(patchFile, 'patch entry must point at a patch file path');
  assert.ok(existsSync(new URL(`./${patchFile}`, rootUrl)), `patch file must exist: ${patchFile}`);

  const lockfile = readText('pnpm-lock.yaml');
  const hashMatch = lockfile.match(/'@openagentinternet\/agent-browser-ui@0\.10\.2': ([0-9a-f]{64})/);
  assert.ok(hashMatch, 'lockfile must register the 0.10.2 patch hash');
  // historical patch files stay in patches/, but the lockfile resolves 0.10.2 only
  assert.ok(
    !lockfile.includes('agent-browser-ui@0.10.1'),
    'lockfile must not reference agent-browser-ui 0.10.1 anywhere',
  );
});

test('installed tree ships the five ABC packages at 0.10.2 and leaves abitype alone', () => {
  for (const name of ABC_ALL_PACKAGES) {
    const pkg = readJson(`node_modules/${name}/package.json`);
    assert.equal(pkg.version, '0.10.2', `installed ${name} must be 0.10.2`);
  }
  const abitype = readJson('node_modules/abitype/package.json');
  assert.equal(abitype.version, '0.10.0', 'unrelated abitype must stay at 0.10.0');
});

test('installed agent-browser-ui renderer carries the allow-forms sandbox patch', () => {
  const uiRoot = 'node_modules/@openagentinternet/agent-browser-ui';
  const patchedFiles = [
    'dist/browser/app.js',
    'dist/browserClientScript.js',
    'dist/renderers.js',
    'dist-cjs/browser/app.js',
    'dist-cjs/browserClientScript.js',
    'dist-cjs/renderers.js',
  ];
  for (const file of patchedFiles) {
    const source = readText(`${uiRoot}/${file}`);
    assert.ok(
      source.includes('allow-scripts allow-downloads allow-forms'),
      `${file} must sandbox opaque frames with allow-forms`,
    );
    assert.ok(
      source.includes('allow-scripts allow-same-origin allow-downloads allow-forms'),
      `${file} must sandbox cross-origin frames with allow-forms`,
    );
  }
});

test('the PDF viewer iframe intentionally keeps its sandbox without allow-forms', () => {
  const clientScript = readText(
    'node_modules/@openagentinternet/agent-browser-ui/dist/browserClientScript.js',
  );
  const pdfIndex = clientScript.indexOf("class=\"browser-pdf\" sandbox=\"");
  assert.notEqual(pdfIndex, -1, 'PDF iframe sandbox attribute must stay present');
  const sandboxAttribute = clientScript
    .slice(pdfIndex)
    .match(/sandbox="([^"]*)"/)?.[1];
  assert.ok(sandboxAttribute, 'PDF iframe sandbox attribute must be readable');
  assert.ok(
    !sandboxAttribute.includes('allow-forms'),
    'PDF viewer sandbox must not gain allow-forms (kept intentionally narrow)',
  );
});
