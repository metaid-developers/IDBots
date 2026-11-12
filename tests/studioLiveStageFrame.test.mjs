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
    reportUri: 'preview-metaapp://localhost/tmp/final-report.html',
  });
  assert.match(html, /data:image\/jpeg;base64,AA==/);
  assert.match(html, /window.__INITIAL_LIVE_STAGE__=/);
  assert.match(html, /window.__LIVE_STAGE_REPORT_URI__="preview-metaapp:\/\/localhost\/tmp\/final-report\.html"/);
  assert.match(html, /window.__FALLBACK_AVATAR__="data:image\/png;base64,BB=="/);
  assert.doesNotMatch(html, /=__FALLBACK_AVATAR__/);
  assert.match(html, /window.LiquidOrbEffectSource/);
  assert.match(html, /window.IDBotsLiveStage/);
  assert.doesNotMatch(html, /__AVATAR_DATA_URI__|__STAGE_JS__|__ORB_EFFECT__|__REPORT_URI__/);
});

test('frame patch script JSON-injects state and escapes HTML-significant characters', () => {
  const current = { ...state(), headline: '</script><script>alert(1)</script>' };
  const script = buildLiveStagePatchScript(current);
  assert.doesNotThrow(() => new Function(`return ${script};`));
  assert.doesNotMatch(script, /<script>/);
  assert.match(script, /window\.IDBotsLiveStage/);
  assert.match(script, /\.applyPatch\(/);
  assert.match(script, /'not-ready'|'turn-mismatch'|'stale-revision'|'protocol'/);
});

test('frame bridge reaches only the matching local preview frame', async () => {
  const url = 'http://127.0.0.1:5000/live-stage.html';
  let executed = null;
  const frame = {
    url,
    frames: [],
    executeJavaScript: async (script) => {
      if (script.includes('getState')) return { bridge: true, turnId: 't' };
      executed = script;
      return { ok: true };
    },
  };
  const root = { url: 'http://127.0.0.1:5185', frames: [frame], executeJavaScript: async () => ({}) };
  await applyStudioLiveStagePatch({
    getWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame: root } }],
    executeTabCommand: async () => ({ info: { current: { renderer: { type: 'html-iframe', url } } } }),
  }, { tabId: 7, state: state() });
  assert.ok(executed.includes('idbots.live-stage.v1'));
});

test('frame selection probes every matching frame and prefers the one showing this turn', async () => {
  const url = 'http://127.0.0.1:5000/live-stage.html';
  const scripts = { stale: [], fresh: [] };
  const makeFrame = (turnId, bucket) => ({
    url,
    frames: [],
    executeJavaScript: async (script) => {
      if (script.includes('getState')) return { bridge: true, turnId };
      bucket.push(script);
      return { ok: true };
    },
  });
  const stale = makeFrame('turn-old', scripts.stale);
  const fresh = makeFrame('t', scripts.fresh);
  const deps = {
    getWindows: () => [{
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, mainFrame: { url: 'http://127.0.0.1:5185', frames: [stale, fresh], executeJavaScript: async () => ({}) } },
    }],
    executeTabCommand: async () => ({ info: { current: { renderer: { type: 'html-iframe', url } } } }),
  };
  await applyStudioLiveStagePatch(deps, { tabId: 7, state: state() });
  assert.equal(scripts.stale.length, 0, 'the stale frame never receives the patch');
  assert.equal(scripts.fresh.length, 1);
  assert.ok(scripts.fresh[0].includes('idbots.live-stage.v1'));

  // Bridges exist but none belongs to this turn → a machine-readable
  // turn-mismatch the service turns into a re-projection.
  const mismatch = await applyStudioLiveStagePatch({
    ...deps,
    getWindows: () => [{
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, mainFrame: { url: 'http://127.0.0.1:5185', frames: [makeFrame('turn-other', [])], executeJavaScript: async () => ({}) } },
    }],
  }, { tabId: 7, state: state() }).catch((error) => error);
  assert.equal(mismatch?.reason, 'turn-mismatch');

  // Frames exist but none exposes the bridge yet → not-ready (retryable).
  const notReady = await applyStudioLiveStagePatch({
    ...deps,
    getWindows: () => [{
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, mainFrame: { url: 'http://127.0.0.1:5185', frames: [{ url, executeJavaScript: async () => null }], executeJavaScript: async () => ({}) } },
    }],
  }, { tabId: 7, state: state() }).catch((error) => error);
  assert.equal(notReady?.reason, 'not-ready');
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

  // A not-ready page must REJECT, not return an empty queue — an empty array
  // is indistinguishable from "no clicks yet" and the poller would sit
  // silently forever (2026-11-12 MetaPo retest).
  const notReady = await drainStudioLiveStageInteractions({
    ...deps,
    getWindows: () => [{
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, mainFrame: { url: 'http://127.0.0.1:5185', frames: [{ url, executeJavaScript: async () => ({ ok: false, reason: 'live-stage-not-ready', items: [] }) }] } },
    }],
  }, { tabId: 7 }).catch((error) => error);
  assert.ok(notReady instanceof Error, 'a not-ready stage must surface as an error');
  assert.match(notReady.message, /live-stage-not-ready/);
});
