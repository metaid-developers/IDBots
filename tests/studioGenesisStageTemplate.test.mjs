import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const require = Module.createRequire(import.meta.url);
const { renderGenesisStageHtml } = require('../dist-electron/main/services/studioGenesisStageTemplate.js');
const { createGenesisStageState, applyTurnText } = require('../dist-electron/main/services/studioGenesisStageModel.js');

const assets = {
  genesisRoot: path.resolve('public/genesis-stage'),
  orbRoot: path.resolve('public/live-stage'),
  fallbackAvatarDataUri: 'data:image/png;base64,AA==',
};
const readGenesis = (name) => fs.readFileSync(path.join(assets.genesisRoot, name), 'utf8');

test('the Genesis package ships every asset the renderer and demo need', () => {
  for (const name of ['genesis.html', 'genesis.css', 'genesis.js', 'genesis-fallback-orb.js', 'index.html', 'demo.js']) {
    assert.ok(fs.existsSync(path.join(assets.genesisRoot, name)), name);
  }
  const demo = readGenesis('index.html');
  assert.match(demo, /src="\.\.\/live-stage\/liquid-orb-effect\.js"/);
  assert.match(demo, /src="\.\.\/live-stage\/liquid-orb\.js"/);
  assert.doesNotMatch(demo, /https?:\/\//, 'the demo works offline');
});

test('renderGenesisStageHtml inlines assets and state in a single safe pass', () => {
  let state = createGenesisStageState({ sessionId: 's-1', language: 'en', botName: 'Pix __AVATAR_URI__ __GENESIS_JS__', globalMetaId: 'idq1abc' });
  state = applyTurnText(state, {
    turnId: 'greeting',
    kind: 'greeting',
    text: 'Hello! </script><script>alert(1)</script> I said `__INITIAL_STATE__` on purpose.\n\nBye.',
    complete: true,
  });
  const html = renderGenesisStageHtml({ state, avatarDataUri: 'data:image/png;base64,BB==', assets });
  for (const token of ['__GENESIS_CSS__', '=__INITIAL_STATE__', '=__AVATAR_URI__;', '=__FALLBACK_AVATAR_URI__;', '<script>__ORB_EFFECT__', '<script>__GENESIS_JS__']) {
    assert.ok(!html.includes(token), `${token} was replaced`);
  }
  assert.equal((html.match(/<\/script>/g) ?? []).length, 5, 'bot text cannot close a script tag');
  assert.ok(html.includes(readGenesis('genesis.js')));
  assert.ok(html.includes(fs.readFileSync(path.join(assets.orbRoot, 'liquid-orb.js'), 'utf8')));

  const boot = html.match(/<script>(window\.__INITIAL_GENESIS__=[\s\S]*?)<\/script>/)[1];
  const window = {};
  vm.runInNewContext(boot, { window });
  assert.deepEqual(JSON.parse(JSON.stringify(window.__INITIAL_GENESIS__)), JSON.parse(JSON.stringify(state)));
  assert.equal(window.__GENESIS_AVATAR__, 'data:image/png;base64,BB==');
  assert.equal(window.__FALLBACK_AVATAR__, 'data:image/png;base64,AA==');
});

test('the stage runtime keeps the host contract and never injects HTML', () => {
  const runtime = readGenesis('genesis.js');
  assert.match(runtime, /const PROTOCOL = 'idbots\.genesis-stage\.v1';/);
  assert.match(runtime, /applyPatch\(patch\) \{/);
  assert.match(runtime, /patch\.revision <= state\.revision\) return false;/);
  assert.match(runtime, /drainActions\(sessionId\) \{\n      if \(sessionId !== undefined && sessionId !== state\.sessionId\) return \[\];\n      return actionQueue\.splice\(0, actionQueue\.length\);/);
  assert.match(runtime, /actionQueue\.push\(\{ token, choice \}\);/);
  for (const source of [runtime, readGenesis('genesis-fallback-orb.js'), readGenesis('demo.js')]) {
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|document\.write/);
  }
  assert.match(readGenesis('genesis-fallback-orb.js'), /window\.createFallbackOrb = function createFallbackOrb/);
});
