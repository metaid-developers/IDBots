import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const surfaceSource = readFileSync(
  new URL('../src/renderer/features/botBrowser/BotBrowserSurface.tsx', import.meta.url),
  'utf8',
);
const panelSource = readFileSync(
  new URL('../src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx', import.meta.url),
  'utf8',
);
const serviceSource = readFileSync(
  new URL('../src/renderer/services/browserCowork.ts', import.meta.url),
  'utf8',
);
const typesSource = readFileSync(
  new URL('../src/renderer/features/botBrowser/types.ts', import.meta.url),
  'utf8',
);

function getSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('surface consumes ABC picker frames before the idbots-bridge source filter', () => {
  const handler = getSection(
    surfaceSource,
    'const handleMessage = (event: MessageEvent) => {',
    "if (data.type === 'browser-ready') {",
  );
  const dispatchIndex = handler.indexOf('selectionsBridgeRef.current?.handleMessage(data)');
  const sourceFilterIndex = handler.indexOf("data.source !== 'idbots-browser-iframe-bridge'");
  assert.notEqual(dispatchIndex, -1, 'surface must dispatch ABC picker frames');
  assert.ok(
    dispatchIndex < sourceFilterIndex,
    'ABC picker frames must be consumed before the idbots bridge source check',
  );
});

test('picker bridge lifecycle lives in an effect, not render (StrictMode trap)', () => {
  // dispose() is terminal: a bridge created during render is killed by
  // StrictMode's dev mount/cleanup/mount pass and never rebuilt (the
  // render-phase ref init does not re-run), silently swallowing every
  // changed-event refetch. The creation must sit in an effect whose cleanup
  // nulls the ref, declared BEFORE the message-listener effect so each mount
  // has a bridge to dispatch to.
  const effectBody = getSection(
    surfaceSource,
    '// ABC element-picker bridge (v0.10.0): request/response envelopes plus',
    '}, []);',
  );
  assert.match(effectBody, /useEffect\(\(\) => \{/);
  assert.match(effectBody, /selectionsBridgeRef\.current = createBrowserElementSelectionsBridge\(/);
  assert.match(effectBody, /selectionsBridgeRef\.current\?\.dispose\(\);/);
  assert.match(effectBody, /selectionsBridgeRef\.current = null;/);

  const bridgeEffectStart = surfaceSource.indexOf('// ABC element-picker bridge (v0.10.0)');
  const listenerEffectStart = surfaceSource.indexOf('const handleMessage = (event: MessageEvent) => {');
  assert.ok(
    bridgeEffectStart !== -1 && listenerEffectStart !== -1 && bridgeEffectStart < listenerEffectStart,
    'bridge creation effect must be declared before the message listener effect',
  );
  // Negative control: no bridge creation may appear in the render-phase
  // region of the component (anything before the bridge effect's own body).
  const renderPhaseRegion = surfaceSource.slice(
    surfaceSource.indexOf('const endpointShimRef'),
    surfaceSource.indexOf('createBrowserElementSelectionsBridge(', bridgeEffectStart),
  );
  assert.ok(
    !renderPhaseRegion.includes('selectionsBridgeRef.current = createBrowserElementSelectionsBridge('),
    'render-phase bridge creation must stay removed',
  );
});

test('surface registers the live fetcher into the shared picker store', () => {
  assert.match(
    surfaceSource,
    /elementSelectionsStore\.registerFetcher\(\(tabId\) => \{[\s\S]*?bridge\.getElementSelections\(tabId\)/,
  );
  assert.match(surfaceSource, /onSnapshot: \(snapshot\) => elementSelectionsStore\.recordSnapshot\(snapshot\)/);
});

test('surface disposes the picker bridge and exposes both read/clear on the handle', () => {
  assert.match(surfaceSource, /selectionsBridgeRef\.current\?\.dispose\(\)/);
  const handle = getSection(
    surfaceSource,
    'useImperativeHandle(ref, () => ({',
    '}), [clearElementSelections',
  );
  assert.match(handle, /getElementSelections,/);
  assert.match(handle, /clearElementSelections,/);
});

test('panel captures picker marks at submit time and prepends the block', () => {
  const submit = getSection(
    panelSource,
    'const handleSubmit = async (prompt: string, skillPrompt?: string) => {',
    'if (skillIds.length > 0) {',
  );
  assert.match(submit, /elementSelectionsStore\.capturePromptBlock\(\)/);
  assert.match(submit, /return markedElementsBlock \? `\$\{markedElementsBlock\}\\n\\n\$\{prompt\}` : prompt;/);
  assert.match(submit, /const outgoingPrompt = await captureOutgoingPrompt\(\);/);
  assert.match(submit, /browserCoworkService\.send\(outgoingPrompt, skills\)/);
  assert.match(submit, /browserCoworkService\.start\(prompt/);
  // First-send enrichment runs after the optimistic bubble; the title still
  // comes from the owner's words rather than the context block.
  assert.match(submit, /}, skills, startProjectId, prompt, captureOutgoingPrompt\);/);
});

test('browserCowork start keeps the title source separate from the prompt body', () => {
  assert.match(serviceSource, /const titlePrompt = titleSource\?\.trim\(\) \? titleSource : prompt;/);
  assert.match(serviceSource, /coworkService\.generateSessionTitle\(titlePrompt\)/);
  assert.match(serviceSource, /const fallbackTitle = titlePrompt\.split\('\\n'\)\[0\]/);
});

test('surface handle type declares the ABC picker read/clear contract', () => {
  assert.match(typesSource, /getElementSelections\(tabId\?: number \| string\): Promise<BrowserElementSelectionsSnapshot \| null>;/);
  assert.match(typesSource, /clearElementSelections\(tabId\?: number \| string\): Promise<BotBrowserElementSelectionsClearResult \| null>;/);
});
