import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (relative) => fs.readFileSync(path.resolve(relative), 'utf8');

test('Live Stage settings are wired through IPC, preload, types, allowlist, Settings, and i18n', () => {
  const main = read('src/main/main.ts');
  assert.equal((main.match(/registerIpcHandler\('botHubLiveStage:get'/g) ?? []).length, 1);
  assert.equal((main.match(/registerIpcHandler\('botHubLiveStage:set'/g) ?? []).length, 1);
  assert.match(main, /getBotHubLiveStageService\(\)\.observeMessage\(sessionId, message/);
  assert.match(main, /getBotHubLiveStageService\(\)\.observeComplete\(sessionId\)/);
  assert.match(main, /getBotHubLiveStageService\(\)\.projectReport/);

  const preload = read('src/main/preload.ts');
  assert.match(preload, /botHubLiveStage:\s*\{/);
  const types = read('src/renderer/types/electron.d.ts');
  assert.match(types, /botHubLiveStage:\s*\{/);
  const allowlist = read('src/main/gateway/allowlist.ts');
  assert.match(allowlist, /'botHubLiveStage:get'/);
  assert.match(allowlist, /'botHubLiveStage:set'/);
  const settings = read('src/renderer/components/Settings.tsx');
  assert.match(settings, /window\.electron\.botHubLiveStage\.get\(\)/);
  assert.match(settings, /window\.electron\.botHubLiveStage\.set\(updates\)/);
  assert.match(settings, /handleLiveStageSettings/);
  const i18n = read('src/renderer/services/i18n.ts');
  for (const key of ['botHubLiveStage', 'botHubLiveStageDescription', 'botHubLiveStageDirector', 'botHubLiveStageDirectorDescription']) {
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
