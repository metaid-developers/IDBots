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
  assert.match(main, /getBotBrowserProjection\(\)\.project\(\{/);
  // Reports land in the session's showcase role and reveal — never the stage tab.
  assert.match(main, /role: 'showcase',[\s\S]{0,80}reveal: true,/);
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
  // studioLiveStageDescription was retired with its Settings copy drop
  // (5d454e66: the Live Stage card now renders title + toggle label only).
  for (const key of ['studioLiveStage', 'studioLiveStageToggle', 'studioLiveStageDirector', 'studioLiveStageDirectorDescription']) {
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

test('pending permissions present on the Studio stage card and clear on resolution', () => {
  const main = read('src/main/main.ts');
  assert.match(main, /getStudioLiveStageService\(\)\.presentInteraction\(sessionId, request\)/);
  assert.match(main, /getStudioLiveStageService\(\)\.clearInteraction\(sessionId, requestId\)/);
  assert.match(main, /const stageInteractionQueue = new Map</);
  assert.match(main, /drainInteractions: \(tabId, sessionId\) => drainStudioLiveStageInteractions\(/);
  assert.match(main, /respondToPermission: \(requestId, result\) =>/);
  const service = read('src/main/services/studioLiveStageService.ts');
  assert.match(service, /presentInteraction\(sessionId: string, request: unknown\): 'presented' \| 'busy' \| 'declined'/);
  assert.match(service, /function startInteractionPolling\(run: LiveStageRun\): void/);
});

test('skip travels as an explicit honest list through panel, runner, and stage', () => {
  const runner = read('src/main/libs/coworkRunner.ts');
  assert.match(runner, /skipped\.has\(q\.question\)/);
  assert.match(runner, /\{ id: q\.id, selected: \[\] \}/);
  assert.match(runner, /updatedInput\.skippedQuestions/);
  const panel = read('src/renderer/components/cowork/CoworkPermissionPanel.tsx');
  assert.match(panel, /skippedQuestions: skippedTexts/);
  const service = read('src/main/services/studioLiveStageService.ts');
  assert.match(service, /skippedQuestions: interaction\.questions\.map\(\(question\) => question\.question\)/);
});

test('stage card presentation state drives the corner-overlay dedup end to end', () => {
  const main = read('src/main/main.ts');
  assert.match(main, /'cowork:stream:stageInteraction', \{ sessionId, requestId: stageRequestId, presented: true \}/);
  assert.match(main, /'cowork:stream:stageInteraction', \{ sessionId, requestId, presented: false \}/);
  assert.match(main, /stagePresentedRequestIds: getStudioLiveStageService\(\)\.listPresentedRequestIds\(\)/);
  const allowlist = read('src/main/gateway/allowlist.ts');
  assert.match(allowlist, /'cowork:stream:stageInteraction': \{ tier: 'P1'/);
  const preload = read('src/main/preload.ts');
  assert.match(preload, /onStreamStageInteraction/);
  const dts = read('src/renderer/types/electron.d.ts');
  assert.match(dts, /onStreamStageInteraction/);
  const slice = read('src/renderer/store/slices/coworkSlice.ts');
  assert.match(slice, /setStageInteractionPresented/);
  assert.match(slice, /stagePresentedRequestIds: \[\]/);
  const service = read('src/renderer/services/cowork.ts');
  assert.match(service, /onStreamStageInteraction/);
  const app = read('src/renderer/App.tsx');
  assert.match(app, /stageSessionId=\{botBrowserShell\.isBrowserPaneVisible \? browserSessionId : null\}/);
  const overlay = read('src/renderer/components/cowork/CoworkPermissionOverlay.tsx');
  assert.match(overlay, /stageSessionId\?: string \| null/);
  assert.match(overlay, /stagePresentedRequestIds\.has\(entry\.requestId\)/);
});

test('pushed stage answers ride the shell bridge relay into main', () => {
  const bridge = read('src/renderer/features/botBrowser/browserIframeBridge.ts');
  assert.match(bridge, /type: 'stage-interaction'/);
  assert.match(bridge, /entryShapeOk/);
  const surface = read('src/renderer/features/botBrowser/BotBrowserSurface.tsx');
  assert.match(surface, /submitStageInteractionAnswer\(data\.entry\)/);
  const allowlist = read('src/main/gateway/allowlist.ts');
  assert.match(allowlist, /'cowork:stageInteraction:answer': \{ tier: 'P1'/);
  const main = read('src/main/main.ts');
  assert.match(main, /registerIpcHandler\('cowork:stageInteraction:answer'/);
  assert.match(main, /acceptPushedInteraction\(options\?\.entry\)/);
  const service = read('src/main/services/studioLiveStageService.ts');
  assert.match(service, /function acceptPushedInteraction\(entry: unknown\): boolean/);
});
