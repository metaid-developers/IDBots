import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

// Pins the Agent Browser Core v0.10.1 integration contract: the four direct
// ABC dependencies move together, the allow-forms sandbox patch is re-issued
// against the 0.10.1 package (never a mechanical key rename), the installed
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
const PATCH_KEY = `${PATCHED_UI_PACKAGE}@0.10.1`;

test('all four direct ABC dependencies pin 0.10.1 in package.json', () => {
  const manifest = readJson('package.json');
  for (const name of ABC_DIRECT_DEPS) {
    assert.equal(manifest.dependencies?.[name], '0.10.1', `${name} must pin 0.10.1`);
  }
});

test('minimumReleaseAgeExclude lists 0.10.1 for every ABC package', () => {
  const workspaceYaml = readText('pnpm-workspace.yaml');
  for (const name of ABC_ALL_PACKAGES) {
    const entry = workspaceYaml
      .split('\n')
      .find((line) => line.trim().startsWith(`- '${name}@`));
    assert.ok(entry, `minimumReleaseAgeExclude must keep an entry for ${name}`);
    assert.ok(
      entry.includes('0.10.1'),
      `${name} exclusion expression must include 0.10.1`,
    );
  }
});

test('patchedDependencies re-issues the allow-forms patch against 0.10.1', () => {
  const workspaceYaml = readText('pnpm-workspace.yaml');
  const patchLine = workspaceYaml
    .split('\n')
    .find((line) => line.includes(`'${PATCH_KEY}'`));
  assert.ok(patchLine, `patchedDependencies must key ${PATCH_KEY}`);
  assert.ok(
    !/agent-browser-ui@0\.10\.0/.test(workspaceYaml),
    'the stale 0.10.0 patchedDependencies key must be gone',
  );

  const patchFile = patchLine.split("': ")[1]?.trim().replace(/^'/, '');
  assert.ok(patchFile, 'patch entry must point at a patch file path');
  assert.ok(existsSync(new URL(`./${patchFile}`, rootUrl)), `patch file must exist: ${patchFile}`);

  const lockfile = readText('pnpm-lock.yaml');
  const hashMatch = lockfile.match(/'@openagentinternet\/agent-browser-ui@0\.10\.1': ([0-9a-f]{64})/);
  assert.ok(hashMatch, 'lockfile must register the 0.10.1 patch hash');
  // historical patch files stay in patches/, but the lockfile resolves 0.10.1 only
  assert.ok(
    !lockfile.includes('agent-browser-ui@0.10.0'),
    'lockfile must not reference agent-browser-ui 0.10.0 anywhere',
  );
});

test('installed tree ships the five ABC packages at 0.10.1 and leaves abitype alone', () => {
  for (const name of ABC_ALL_PACKAGES) {
    const pkg = readJson(`node_modules/${name}/package.json`);
    assert.equal(pkg.version, '0.10.1', `installed ${name} must be 0.10.1`);
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
