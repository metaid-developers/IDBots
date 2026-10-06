import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/renderer/features/botBrowser/BotBrowserSurface.tsx', import.meta.url),
  'utf8',
);

function getSection(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);

  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);

  return source.slice(start, end);
}

test('surface gates pending intent flushing on browser-ready', () => {
  assert.match(
    source,
    /const flushPendingOpenUris = useCallback\(\(\) => \{\s*if \(!readyRef\.current\) return;/,
  );
  assert.match(
    source,
    /const flushPendingRefreshRuntime = useCallback\(\(\) => \{\s*if \(!readyRef\.current\) return;/,
  );
});

test('surface does not post open-uri before browser-ready', () => {
  const openUriSection = getSection(
    'async openUri(input: BotBrowserOpenUriInput): Promise<void> {',
    '      async refreshRuntime(): Promise<void> {',
  );

  assert.match(openUriSection, /if \(!readyRef\.current\) \{/);
  assert.ok(
    openUriSection.indexOf('if (!readyRef.current) {') < openUriSection.indexOf('postOpenUri(input)'),
    'ready gate should run before postOpenUri',
  );
});

test('surface does not post refresh-runtime before browser-ready', () => {
  const refreshRuntimeSection = getSection(
    'async refreshRuntime(): Promise<void> {',
    '    }), [controlTabs, ensureSrcDoc, postOpenUri, postToIframe]);',
  );

  assert.match(refreshRuntimeSection, /if \(!readyRef\.current\) \{/);
  assert.ok(
    refreshRuntimeSection.indexOf('if (!readyRef.current) {') < refreshRuntimeSection.indexOf("postToIframe({ type: 'refresh-runtime' })"),
    'ready gate should run before refresh-runtime post',
  );
});

test('surface does not flush pending intents from iframe load events', () => {
  assert.doesNotMatch(source, /const handleIframeLoad = useCallback\(/);
  assert.doesNotMatch(source, /onLoad=\{handleIframeLoad\}/);
});

test('surface wires Bot Browser MetaApp cache IPC into the host adapter', () => {
  const adapterSection = getSection(
    'const adapter = createIdbotsBrowserHostAdapter({',
    '      endpointShimRef.current = createBrowserEndpointShim(adapter);',
  );

  assert.match(adapterSection, /resolveMetaAppPin:\s*async \(pinId\) =>/);
  assert.match(adapterSection, /window\.electron\.botBrowser\.resolveMetaAppPin\(\{ pinId \}\)/);
  assert.match(adapterSection, /getMetaAppCache:\s*\(\) => window\.electron\.botBrowser\.getMetaAppCache\(\)/);
  assert.match(adapterSection, /clearMetaAppCache:\s*\(input\) => window\.electron\.botBrowser\.clearMetaAppCache\(input\)/);
});

// The MetaApp iframe (and its sandbox attribute) is built at runtime by the ABC
// browser client from htmlFrameSandbox(url); the rendered HTML we hand to srcDoc
// does not contain that element yet. Post-processing it to re-add
// allow-same-origin (the retired relaxMetaAppIframeSandbox) was therefore both
// ineffective and contrary to the upstream opaque-frame contract. allow-forms
// is added at the dependency source via
// patches/@openagentinternet+agent-browser-ui+0.7.0.patch.
const SANDBOX_RELAXATION_RE = /relaxMetaAppIframeSandbox/;

test('surface renders the packaged Browser HTML without rewriting the iframe sandbox', () => {
  assert.match(
    source,
    /import \{ injectBrowserIframeBridge \} from '\.\/browserIframeBridge';/,
  );
  assert.match(
    source,
    /const html = await renderBrowserPageHtml\(\s*definition,\s*getBrowserLanguagePreference\(\),\s*\{ theme: themeService\.getEffectiveTheme\(\) \},\s*\);/,
  );
  assert.doesNotMatch(source, SANDBOX_RELAXATION_RE);
});

test('negative control: the sandbox-relaxation guard flags the retired relaxation call', () => {
  const retiredSource = [
    "import { injectBrowserIframeBridge, relaxMetaAppIframeSandbox } from './browserIframeBridge';",
    'const html = relaxMetaAppIframeSandbox(',
    '  await renderBrowserPageHtml(definition, getBrowserLanguagePreference(), { theme: themeService.getEffectiveTheme() }),',
    ');',
  ].join('\n');
  assert.match(
    retiredSource,
    SANDBOX_RELAXATION_RE,
    'the guard must have teeth: it has to detect the retired rewrite when present',
  );
});

// Pre-existing stale expectation, repaired here: patchBrowserNavButtonSync was
// retired when ABC 0.5.4 shipped the toolbar re-sync upstream (see the sentinel
// in tests/browserNavButtonSync.test.ts). The surface now injects the bridge
// straight into buildBrowserPageDefinition().
test('surface builds the ABC page definition without the retired nav-button sync patch', () => {
  assert.match(
    source,
    /const definition = injectBrowserIframeBridge\(\s*buildBrowserPageDefinition\(\),\s*\);/,
  );
  assert.doesNotMatch(source, /patchBrowserNavButtonSync/);
});

test('negative control: the retired nav-button sync guard flags the old wiring', () => {
  const retiredSource = 'const definition = injectBrowserIframeBridge(\n  patchBrowserNavButtonSync(buildBrowserPageDefinition()),\n);';
  assert.match(
    retiredSource,
    /patchBrowserNavButtonSync/,
    'the guard must have teeth: it has to detect the old wiring when present',
  );
});

test('surface uses the ABC theme contract for initial paint and runtime changes', () => {
  assert.match(source, /createBrowserThemeMessage/);
  assert.match(source, /themeService\.subscribe/);
  assert.match(source, /target\.postMessage\(createBrowserThemeMessage\(themeService\.getEffectiveTheme\(\)\), '\*'\)/);
  assert.match(source, /postThemeToIframe\(\);\s*callbacksRef\.current\.onReady/);
});

test('surface exposes request-response tab control without storing tab state', () => {
  assert.match(source, /controlTabs\(command: BotBrowserTabCommand\)/);
  assert.match(source, /pendingTabResponsesRef\.current\.get\(data\.id\)/);
  assert.match(source, /postToIframe\(\{ type: 'tab-command', id, command: pending\.command \}\)/);
  assert.doesNotMatch(source, /useState<BotBrowserTabInfo/);
});
