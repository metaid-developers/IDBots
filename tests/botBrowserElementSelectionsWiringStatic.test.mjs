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
  assert.match(submit, /const outgoingPrompt = markedElementsBlock \? `\$\{markedElementsBlock\}\\n\\n\$\{prompt\}` : prompt;/);
  assert.match(submit, /browserCoworkService\.send\(outgoingPrompt, skills\)/);
  assert.match(submit, /browserCoworkService\.start\(outgoingPrompt/);
  // The session title is seeded from the owner's words, not the context block.
  assert.match(submit, /}, skills, startProjectId, prompt\);/);
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
