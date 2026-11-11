import assert from 'node:assert/strict';
import test from 'node:test';

import * as bridgeModule from '../src/renderer/features/botBrowser/browserIframeBridge.ts';

const { buildBrowserIframeBridgeScript } = bridgeModule;

test('bridge gates browser-ready on runtime readiness without DOM timer readiness', () => {
  const script = buildBrowserIframeBridgeScript();

  assert.match(script, /function ensureRuntimeReady\(options\)/);
  assert.match(script, /await globalThis\.loadRuntime\(\);[\s\S]*postReady\(\);/);
  assert.doesNotMatch(script, /setTimeout\(postReady,\s*0\)/);
});

test('bridge waits for runtime readiness before actor selection and navigation', () => {
  const script = buildBrowserIframeBridgeScript();

  assert.match(
    script,
    /async function handleOpenUri\(input\) \{[\s\S]*await ensureRuntimeReady\(\);[\s\S]*await globalThis\.selectUsingIdentity\(actorId\);[\s\S]*await globalThis\.navigateTo\(uri\);[\s\S]*\}/,
  );
});

test('bridge opens user-clicked URIs in a new tab and keeps agent opens in place', () => {
  const script = buildBrowserIframeBridgeScript();
  const openUriBody = script.slice(
    script.indexOf('async function handleOpenUri(input)'),
    script.indexOf('async function handleOpenNewTab()'),
  );

  // newTab opens ride AgentBrowserTabs.openTab(uri, target?) — the runtime
  // creates + activates the tab and seeds the actor (or, since the projection
  // protocol, a { label, actorId? } options object) onto it directly — and
  // must return before the selectUsingIdentity/navigateTo fallback.
  assert.match(openUriBody, /var newTab = Boolean\(input && input\.newTab\);/);
  assert.match(
    openUriBody,
    /if \(newTab && typeof globalThis\.AgentBrowserTabs\.openTab === 'function'\) \{[\s\S]*globalThis\.AgentBrowserTabs\.openTab\(uri[\s\S]*return;\s*\}/,
  );
  assert.match(openUriBody, /var openLabel = textValue\(input && input\.label\);/);
  assert.match(
    openUriBody,
    /Object\.assign\(\{ label: openLabel \}, actorId \? \{ actorId: actorId \} : \{\}\)/,
  );
  assert.ok(
    openUriBody.indexOf('AgentBrowserTabs.openTab(uri') < openUriBody.indexOf('await globalThis.selectUsingIdentity(actorId)'),
    'the new-tab branch must run before the navigate-in-place fallback',
  );
});

test('final report navigation keeps the projector active while background updates restore the previous tab', () => {
  const script = buildBrowserIframeBridgeScript();
  const navigateBody = script.slice(
    script.indexOf("} else if (action === 'navigate-tab')"),
    script.indexOf("} else if (action === 'close-tab')"),
  );
  assert.match(navigateBody, /var activateTarget = input\.activate === true;/);
  assert.match(navigateBody, /if \(!activateTarget && previousActive && previousActive\.id !== navTabId\)/);
  assert.match(navigateBody, /await navigation;/);
});

test('bridge clears failed runtime readiness state so later intents can retry', () => {
  const script = buildBrowserIframeBridgeScript();

  assert.match(script, /if \(!forceReload && runtimeReadyPromise\) \{\s*return runtimeReadyPromise;\s*\}/);
  assert.match(script, /runtimeReadyPromise = null;/);
  assert.match(script, /\.catch\(function \(error\) \{[\s\S]*runtimeReadyPromise = null;[\s\S]*throw error;[\s\S]*\}\)/);
});

test('bridge refresh-runtime forceReload bypasses cached runtimeReadyPromise', () => {
  const script = buildBrowserIframeBridgeScript();

  assert.match(
    script,
    /function ensureRuntimeReady\(options\) \{[\s\S]*var forceReload = Boolean\(options && options\.forceReload\);[\s\S]*if \(!forceReload && runtimeReadyPromise\) \{\s*return runtimeReadyPromise;\s*\}[\s\S]*await globalThis\.loadRuntime\(\);/,
  );
});

// The MetaApp iframe sandbox is decided upstream by ABC's htmlFrameSandbox(url)
// and concatenated into the served page at runtime. A client-side string
// rewrite of the rendered HTML (the retired relaxMetaAppIframeSandbox) could
// never reach that attribute and re-adding allow-same-origin to a same-origin
// frame reverses the upstream "same-origin frames stay opaque" contract. The
// module must therefore not expose such a helper; allow-forms is added at the
// source via patches/@openagentinternet+agent-browser-ui+0.7.0.patch.
const SANDBOX_RELAXATION_EXPORT = 'relaxMetaAppIframeSandbox';

function exposesSandboxRelaxation(module) {
  return typeof module[SANDBOX_RELAXATION_EXPORT] === 'function';
}

test('bridge module no longer exposes a MetaApp sandbox relaxation helper', () => {
  assert.equal(exposesSandboxRelaxation(bridgeModule), false);
});

test('negative control: the sandbox-relaxation guard flags a module that still exposes it', () => {
  const legacyModule = { [SANDBOX_RELAXATION_EXPORT]: (html) => html };
  assert.equal(
    exposesSandboxRelaxation(legacyModule),
    true,
    'the guard must have teeth: it has to detect the retired helper when present',
  );
});

test('only the active Stage frame can open its own same-directory final report', async () => {
  const { default: vm } = await import('node:vm');
  const listeners = [];
  const navigated = [];
  const frame = {};
  const stageUri = 'preview-metaapp://localhost/work/reports/live-stage-turn-1.html';
  const reportUri = 'preview-metaapp://localhost/work/reports/final-report.html';
  const context = {
    URL,
    Promise,
    setTimeout,
    clearTimeout,
    document: { readyState: 'complete', addEventListener: () => {} },
    parent: { postMessage: () => {} },
    addEventListener: (type, listener) => listeners.push({ type, listener }),
    AgentBrowserTabs: {
      openTab: () => 1,
      closeTab: () => {},
      switchTab: () => {},
      getTabs: () => [{ id: 1, uri: stageUri, isActive: true }],
      getActiveTab: () => ({ id: 1, uri: stageUri, isActive: true }),
    },
    currentBrowserHtmlFrameWindow: () => frame,
    loadRuntime: async () => ({}),
    selectUsingIdentity: async () => {},
    navigateTo: (uri) => {
      navigated.push(uri);
      return Promise.resolve();
    },
  };
  context.window = context;
  vm.runInNewContext(buildBrowserIframeBridgeScript(), context);
  const messageListener = listeners.find((entry) => entry.type === 'message').listener;
  const send = (data, source = frame) => messageListener({ source, data });
  const action = (overrides = {}) => ({
    source: 'idbots-live-stage',
    type: 'open-report',
    turnId: 'turn-1',
    uri: reportUri,
    ...overrides,
  });

  send(action());
  send(action(), {});
  send(action({ turnId: 'turn-2' }));
  send(action({ uri: 'preview-metaapp://localhost/work/other/final-report.html' }));
  send(action({ uri: 'https://example.com/report' }));
  send(action({ uri: 'preview-metaapp://localhost/work/reports/../secret.html' }));

  assert.deepEqual(navigated, [reportUri]);
});
