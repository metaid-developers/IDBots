import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';

const require = Module.createRequire(import.meta.url);
const { createLiveStageState } = require('../dist-electron/main/services/studioLiveStageModel.js');
const { renderLiveStageHtml } = require('../dist-electron/main/services/studioLiveStageTemplate.js');
const { buildLiveStagePatchScript, buildLiveStageDrainScript, applyStudioLiveStagePatch, drainStudioLiveStageInteractions } = require('../dist-electron/main/services/studioLiveStageFrame.js');

const state = () => createLiveStageState({ sessionId: 's', turnId: 't', botName: 'AI_Sunny', language: 'en' });

test('template is self-contained and injects the active Avatar and initial state', () => {
  const html = renderLiveStageHtml({
    state: state(),
    avatarDataUri: 'data:image/jpeg;base64,AA==',
    assets: { assetRoot: path.resolve('public/live-stage'), fallbackAvatarDataUri: 'data:image/png;base64,BB==' },
  });
  assert.match(html, /data:image\/jpeg;base64,AA==/);
  assert.match(html, /window.__INITIAL_LIVE_STAGE__=/);
  assert.match(html, /window.__FALLBACK_AVATAR__="data:image\/png;base64,BB=="/);
  assert.doesNotMatch(html, /=__FALLBACK_AVATAR__/);
  assert.match(html, /window.LiquidOrbEffectSource/);
  assert.match(html, /window.IDBotsLiveStage/);
  assert.doesNotMatch(html, /__AVATAR_DATA_URI__|__STAGE_JS__|__ORB_EFFECT__/);
});

test('frame patch script JSON-injects state and escapes HTML-significant characters', () => {
  const current = { ...state(), headline: '</script><script>alert(1)</script>' };
  const script = buildLiveStagePatchScript(current);
  assert.doesNotThrow(() => new Function(`return ${script};`));
  assert.doesNotMatch(script, /<script>/);
  assert.match(script, /window.IDBotsLiveStage.applyPatch/);
});

test('frame bridge reaches only the matching local preview frame', async () => {
  const url = 'http://127.0.0.1:5000/live-stage.html';
  let executed = null;
  const frame = { url, frames: [], executeJavaScript: async (script) => { executed = script; return { ok: true }; } };
  const root = { url: 'http://127.0.0.1:5185', frames: [frame], executeJavaScript: async () => ({}) };
  await applyStudioLiveStagePatch({
    getWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: root } }],
    executeTabCommand: async () => ({ info: { current: { renderer: { type: 'html-iframe', url } } } }),
  }, { tabId: 7, state: state() });
  assert.ok(executed.includes('idbots.live-stage.v1'));
});

test('drain script consumes the page queue through the same located frame', async () => {
  const script = buildLiveStageDrainScript();
  assert.doesNotThrow(() => new Function(`return ${script};`));
  assert.match(script, /drainInteractions/);
  const url = 'http://127.0.0.1:5000/live-stage.html';
  const drainedScripts = [];
  const frame = {
    url,
    frames: [],
    executeJavaScript: async (script) => {
      drainedScripts.push(script);
      return { ok: true, items: [{ requestId: 'ask-1', token: 'tok', behavior: 'allow', answers: { Q: 'A' } }] };
    },
  };
  const root = { url: 'http://127.0.0.1:5185', frames: [frame], executeJavaScript: async () => ({}) };
  const deps = {
    getWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: root } }],
    executeTabCommand: async () => ({ info: { current: { renderer: { type: 'html-iframe', url } } } }),
  };
  const items = await drainStudioLiveStageInteractions(deps, { tabId: 7 });
  assert.deepEqual(items, [{ requestId: 'ask-1', token: 'tok', behavior: 'allow', answers: { Q: 'A' } }]);
  assert.match(drainedScripts[0], /drainInteractions/);

  const empty = await drainStudioLiveStageInteractions({
    ...deps,
    getWindows: () => [],
  }, { tabId: 7 }).catch((error) => error);
  assert.ok(empty instanceof Error, 'a missing stage frame must surface as an error');
});
