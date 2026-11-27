import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

// Pins the Agent Browser Core v0.11.2 integration contract: the five direct
// ABC dependencies move together, the allow-forms sandbox patch is re-issued
// against the 0.11.2 package (never a mechanical key rename — 0.11.2 reworked
// app.js with the native Chrome-style tab drag and added a tabDragCss injection
// layer to the page's theme CSS chain, so the patch hunks had to be located
// semantically), the installed tree actually carries the patched renderer, the
// tab drag is now native to core (the host-side injection layer was retired in
// the same bump so the two implementations cannot stack), and the unrelated
// third-party abitype@0.10.0 pin is left alone.

const rootUrl = new URL('..', import.meta.url);

const readJson = (relativePath) =>
  JSON.parse(readFileSync(new URL(relativePath, rootUrl), 'utf8'));
const readText = (relativePath) => readFileSync(new URL(relativePath, rootUrl), 'utf8');

const ABC_DIRECT_DEPS = [
  '@openagentinternet/agent-browser-core',
  '@openagentinternet/agent-browser-host-contract',
  '@openagentinternet/agent-browser-name-resolvers',
  '@openagentinternet/agent-browser-renderers',
  '@openagentinternet/agent-browser-ui',
];
const ABC_ALL_PACKAGES = [...ABC_DIRECT_DEPS];
const PATCHED_UI_PACKAGE = '@openagentinternet/agent-browser-ui';
const PATCH_KEY = `${PATCHED_UI_PACKAGE}@0.11.2`;
const PATCHED_CORE_PACKAGE = '@openagentinternet/agent-browser-core';
const CORE_PATCH_KEY = `${PATCHED_CORE_PACKAGE}@0.11.2`;

test('all five direct ABC dependencies pin 0.11.2 in package.json', () => {
  const manifest = readJson('package.json');
  for (const name of ABC_DIRECT_DEPS) {
    assert.equal(manifest.dependencies?.[name], '0.11.2', `${name} must pin 0.11.2`);
  }
});

test('minimumReleaseAgeExclude lists 0.11.2 for every ABC package', () => {
  const workspaceYaml = readText('pnpm-workspace.yaml');
  for (const name of ABC_ALL_PACKAGES) {
    const entry = workspaceYaml
      .split('\n')
      .find((line) => line.trim().startsWith(`- '${name}@`));
    assert.ok(entry, `minimumReleaseAgeExclude must keep an entry for ${name}`);
    assert.ok(
      entry.includes('0.11.2'),
      `${name} exclusion expression must include 0.11.2`,
    );
  }
});

test('patchedDependencies re-issues the allow-forms patch against 0.11.2', () => {
  const workspaceYaml = readText('pnpm-workspace.yaml');
  // pnpm patch-commit may serialize the mapping in block or flow style, so
  // extract the patch path with a regex instead of line layout assumptions.
  const patchEntry = workspaceYaml.match(
    new RegExp(`'${PATCH_KEY.replace('.', '\\.')}':\\s*(patches/[^'\\s}]+)`),
  );
  assert.ok(patchEntry, `patchedDependencies must key ${PATCH_KEY}`);
  assert.ok(
    !/agent-browser-ui@0\.11\.0/.test(workspaceYaml),
    'the stale 0.11.0 patchedDependencies key must be gone',
  );
  assert.ok(
    !/agent-browser-ui@0\.10\./.test(workspaceYaml),
    'the stale 0.10.x patchedDependencies keys must be gone',
  );
  // The 0.11.1 key is kept on purpose as the rollback target after the bump;
  // pnpm 11 only tolerates the unused key via allowUnusedPatches, so the flag
  // must stay.
  assert.ok(
    /'@openagentinternet\/agent-browser-ui@0\.11\.1':/.test(workspaceYaml),
    'the 0.11.1 rollback key must stay in patchedDependencies',
  );
  assert.ok(
    /^allowUnusedPatches:\s*true$/m.test(workspaceYaml),
    'allowUnusedPatches: true must stay while the 0.11.1 rollback key is kept',
  );

  const patchFile = patchEntry[1];
  assert.ok(patchFile, 'patch entry must point at a patch file path');
  assert.ok(existsSync(new URL(`./${patchFile}`, rootUrl)), `patch file must exist: ${patchFile}`);

  const lockfile = readText('pnpm-lock.yaml');
  const hashMatch = lockfile.match(/'@openagentinternet\/agent-browser-ui@0\.11\.2': ([0-9a-f]{64})/);
  assert.ok(hashMatch, 'lockfile must register the 0.11.2 patch hash');
  // historical patch files stay in patches/, but the lockfile resolves 0.11.2 only.
  // Exception: the tolerated 0.11.1 rollback key still records its hash in the
  // patchedDependencies section, so ignore those hash lines before asserting.
  const lockfileWithoutPatchHashLines = lockfile
    .split('\n')
    .filter((line) => !/^\s*'@openagentinternet\/agent-browser-ui@\d+\.\d+\.\d+':\s*[0-9a-f]{64}\s*$/.test(line))
    .join('\n');
  assert.ok(
    !lockfileWithoutPatchHashLines.includes('agent-browser-ui@0.11.1'),
    'lockfile must not resolve agent-browser-ui 0.11.1 anywhere outside the rollback hash line',
  );
  assert.ok(
    !lockfileWithoutPatchHashLines.includes('agent-browser-ui@0.11.0'),
    'lockfile must not reference agent-browser-ui 0.11.0 anywhere',
  );
});

test('installed tree ships the five ABC packages at 0.11.2 and leaves abitype alone', () => {
  for (const name of ABC_ALL_PACKAGES) {
    const pkg = readJson(`node_modules/${name}/package.json`);
    assert.equal(pkg.version, '0.11.2', `installed ${name} must be 0.11.2`);
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

test('installed agent-browser-ui ships native tab drag (the host injection layer is retired)', () => {
  // The host-side browserTabDragScript was removed in this bump; core must
  // carry the interaction itself: URI-keyed order persistence, the drag
  // handler wiring, and the pinned-segment clamp. Pinned against both dist
  // variants since they ship the same page source.
  const appFiles = [
    'node_modules/@openagentinternet/agent-browser-ui/dist/browser/app.js',
    'node_modules/@openagentinternet/agent-browser-ui/dist-cjs/browser/app.js',
  ];
  for (const file of appFiles) {
    const source = readText(file);
    assert.ok(
      source.includes("TAB_ORDER_STORAGE_KEY = 'agent-browser:tab-order'"),
      `${file} must persist tab order in the page's own localStorage`,
    );
    assert.ok(
      source.includes('function bindTabDrag()'),
      `${file} must wire the native dragstart/dragover/drop handlers`,
    );
    assert.ok(
      source.includes('function clampTabInsertIndex('),
      `${file} must clamp free tabs out of the pinned segment`,
    );
    assert.ok(
      source.includes('function isLocalPreviewNavigateHref('),
      `${file} must gate local-preview link navigation to local-preview tabs`,
    );
  }
});

test('patchedDependencies registers the 0.11.2 agent-browser-core special-char URI patch', () => {
  const workspaceYaml = readText('pnpm-workspace.yaml');
  const patchEntry = workspaceYaml.match(
    new RegExp(`'${CORE_PATCH_KEY.replace('.', '\\.')}':\\s*(patches/[^'\\s}]+)`),
  );
  assert.ok(patchEntry, `patchedDependencies must key ${CORE_PATCH_KEY}`);
  const patchFile = patchEntry[1];
  assert.ok(existsSync(new URL(`./${patchFile}`, rootUrl)), `patch file must exist: ${patchFile}`);

  const lockfile = readText('pnpm-lock.yaml');
  const hashMatch = lockfile.match(/'@openagentinternet\/agent-browser-core@0\.11\.2': ([0-9a-f]{64})/);
  assert.ok(hashMatch, 'lockfile must register the 0.11.2 agent-browser-core patch hash');

  const coreRoot = 'node_modules/@openagentinternet/agent-browser-core';
  for (const variant of ['dist', 'dist-cjs']) {
    assert.match(
      readText(`${coreRoot}/${variant}/browser/previewFileUri.js`),
      /encodePreviewUriPath/,
      `${variant}/browser/previewFileUri.js must carry the special-char URI patch`,
    );
    assert.match(
      readText(`${coreRoot}/${variant}/browser/previewMetaAppUri.js`),
      /encodePreviewUriPath/,
      `${variant}/browser/previewMetaAppUri.js must carry the special-char URI patch`,
    );
    assert.match(
      readText(`${coreRoot}/${variant}/browser/previewHtml.js`),
      /preview-file\|preview-metaapp\|file/,
      `${variant}/browser/previewHtml.js must forward local preview internal links`,
    );
  }
});
