import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (relative) => fs.readFileSync(path.resolve(relative), 'utf8');

test('Live Stage settings are wired through IPC, preload, types, allowlist, Settings, and i18n', () => {
  const main = read('src/main/main.ts');
  assert.equal((main.match(/registerIpcHandler\('studioLiveStage:get'/g) ?? []).length, 1);
  assert.equal((main.match(/registerIpcHandler\('studioLiveStage:set'/g) ?? []).length, 1);
  assert.match(main, /getStudioLiveStageService\(\)\.observeMessage\(sessionId, message/);
  assert.match(main, /getStudioLiveStageService\(\)\.observeComplete\(sessionId\)/);
  assert.match(main, /getStudioLiveStageService\(\)\.projectReport/);
  assert.equal((main.match(/\.prepareSession\(/g) ?? []).length, 2);

  const preload = read('src/main/preload.ts');
  assert.match(preload, /studioLiveStage:\s*\{/);
  const types = read('src/renderer/types/electron.d.ts');
  assert.match(types, /studioLiveStage:\s*\{/);
  const allowlist = read('src/main/gateway/allowlist.ts');
  assert.match(allowlist, /'studioLiveStage:get'/);
  assert.match(allowlist, /'studioLiveStage:set'/);
  const settings = read('src/renderer/components/Settings.tsx');
  assert.match(settings, /window\.electron\.studioLiveStage\.get\(\)/);
  assert.match(settings, /window\.electron\.studioLiveStage\.set\(updates\)/);
  assert.match(settings, /handleLiveStageSettings/);
  const i18n = read('src/renderer/services/i18n.ts');
  for (const key of ['studioLiveStage', 'studioLiveStageDescription', 'studioLiveStageDirector', 'studioLiveStageDirectorDescription']) {
    assert.equal((i18n.match(new RegExp(`${key}: '`, 'g')) ?? []).length, 2, `${key} has ZH and EN copy`);
  }
});

test('Live Stage assets ship through the existing dist bundle and retain the orb license', () => {
  for (const file of ['stage.html', 'stage.css', 'stage.js', 'liquid-orb.js', 'liquid-orb-effect.js', 'liquid-orb-LICENSE.txt']) {
    assert.ok(fs.existsSync(path.resolve('public/live-stage', file)), file);
  }
  assert.match(read('electron-builder.json'), /"dist\/\*\*\/\*"/);
  assert.match(read('public/live-stage/liquid-orb-LICENSE.txt'), /MIT License/);
  assert.match(read('public/live-stage/liquid-orb-LICENSE.txt'), /Copyright \(c\) 2026 LerSent001/);
});
