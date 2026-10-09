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

  // newTab opens ride AgentBrowserTabs.openTab(uri, actorId) — the runtime
  // creates + activates the tab and seeds the actor onto it directly — and
  // must return before the selectUsingIdentity/navigateTo fallback.
  assert.match(openUriBody, /var newTab = Boolean\(input && input\.newTab\);/);
  assert.match(
    openUriBody,
    /if \(newTab && typeof globalThis\.AgentBrowserTabs\.openTab === 'function'\) \{[\s\S]*globalThis\.AgentBrowserTabs\.openTab\(uri, actorId \|\| undefined\);[\s\S]*return;\s*\}/,
  );
  assert.ok(
    openUriBody.indexOf('AgentBrowserTabs.openTab(uri') < openUriBody.indexOf('await globalThis.selectUsingIdentity(actorId)'),
    'the new-tab branch must run before the navigate-in-place fallback',
  );
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
