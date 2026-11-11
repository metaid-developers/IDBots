import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (relative) => fs.readFileSync(path.resolve(relative), 'utf8');

test('main sends every stream event to the Genesis Stage before the Live Stage', () => {
  const main = read('src/main/main.ts');
  const pairs = [
    ['getStudioGenesisStageService().observeMessage(sessionId, message as any);', 'getStudioLiveStageService().observeMessage(sessionId, message as any);'],
    ['getStudioGenesisStageService().observeMessage(sessionId, message);', 'getStudioLiveStageService().observeMessage(sessionId, message);'],
    ['getStudioGenesisStageService().observeComplete(sessionId);', 'getStudioLiveStageService().observeComplete(sessionId);'],
    ['getStudioGenesisStageService().observeError(sessionId);', 'getStudioLiveStageService().observeError(sessionId);'],
  ];
  for (const [genesis, live] of pairs) {
    const at = main.indexOf(genesis);
    assert.ok(at > 0, genesis);
    assert.ok(main.indexOf(live, at) > at, `${genesis} runs before ${live}`);
  }
  assert.match(main, /getStudioGenesisStageService\(\)\.observeMessageUpdate\(sessionId, messageId, content\);/);
  assert.match(main, /isSessionClaimed: \(sessionId\) => getStudioGenesisStageService\(\)\.isClaimed\(sessionId\)/);
  assert.match(main, /beforeProjection: \(sessionId\) => getStudioGenesisStageService\(\)\.beforeLiveStageProjection\(sessionId\)/);
  assert.match(main, /runScript: \(input\) => executeStageFrameScript\(frameDeps, input\)/);
  assert.match(main, /submitTurn: async \(input\) => \(await getCoworkTurnSubmissionController\(\)\.submit\(input\)\)\.success/);
  assert.equal((main.match(/\.prepareSession\(/g) ?? []).length, 2, 'no new Live Stage prepare path');
});

test('the Studio greeting is a projector session claimed before its first turn', () => {
  const main = read('src/main/main.ts');
  const start = main.indexOf("registerIpcHandler('cowork:session:createGreeting'");
  const handler = main.slice(start, main.indexOf("registerIpcHandler('cowork:session:ensureA2A'", start));
  assert.match(handler, /surface\?: 'studio';/);
  assert.match(handler, /const studio = options\.surface === 'studio';/);
  assert.match(handler, /studio \? 'browser' : 'standard'/);
  assert.match(handler, /studio \? 'bypassPermissions' : 'default'/);
  const claim = handler.indexOf('getStudioGenesisStageService().claimGreeting(session.id)');
  const run = handler.indexOf('runner.startSession(session.id, greetingPrompt');
  assert.ok(claim > 0 && run > claim, 'claimed before the greeting turn starts');
  assert.match(handler, /permissionMode: studio \? 'bypassPermissions' : getPersistedCoworkPermissionMode\(\)/);

  assert.match(read('src/main/preload.ts'), /createGreetingSession: \(options: \{[^}]*surface\?: 'studio' \}\)/);
  assert.match(read('src/renderer/types/electron.d.ts'), /createGreetingSession: \(options: \{[^}]*surface\?: 'studio' \}\)/);
});

test('the Genesis package ships with the app and has its own test script', () => {
  assert.match(read('electron-builder.json'), /"dist\/\*\*\/\*"/);
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts['test:studio-genesis-stage'], /studioGenesisStageService\.test\.mjs/);
  assert.match(read('public/live-stage/liquid-orb-LICENSE.txt'), /Copyright \(c\) 2026 LerSent001/);
});
