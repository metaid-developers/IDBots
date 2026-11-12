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
    ['getStudioGenesisStageService().observeError(sessionId);', 'getStudioLiveStageService().observeError(sessionId, error);'],
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

test('first-run users land in Studio with a stage-ready greeting prompt', () => {
  const flow = read('src/renderer/components/onboarding/WelcomeFlow.tsx');
  assert.match(flow, /metabotId: twin\.id,\n    surface: 'studio',/);

  const app = read('src/renderer/App.tsx');
  const start = app.indexOf('const handleWelcomeFlowEnter = useCallback(');
  const handler = app.slice(start, app.indexOf('}, [botBrowserShell.openBrowserHome]);', start));
  assert.ok(start > app.indexOf('const botBrowserShell = useBotBrowserShell('), 'declared after the shell it uses');
  assert.match(handler, /await browserCoworkService\.loadSession\(sessionId\);/);
  assert.match(handler, /setStudioSeamState\('split'\);/);
  assert.match(handler, /await botBrowserShell\.openBrowserHome\(\);/);
  assert.doesNotMatch(handler, /coworkService\.loadSession\(sessionId\)/);

  const i18n = read('src/renderer/services/i18n.ts');
  const prompts = [...i18n.matchAll(/welcomeFirstSessionSystemPrompt: (".*"),/g)].map((match) => JSON.parse(match[1]));
  assert.equal(prompts.length, 2);
  const [zh, en] = prompts;
  assert.match(zh, /\{name\}/);
  assert.match(zh, /正好四段，每段一行，格式是「标题：一两句话」/);
  assert.match(zh, /metabot_update/);
  assert.match(en, /\{name\}/);
  assert.match(en, /exactly four paragraphs, one line each, written as "Title: one or two sentences"/);
  assert.match(en, /Never quote specific numbers or amounts/);
});

test('the bot stays off the projector while the Genesis Stage holds it', () => {
  const main = read('src/main/main.ts');
  assert.match(main, /isProjectorHeldByStage: \(sessionId: string\) => getStudioGenesisStageService\(\)\.isClaimed\(sessionId\)/);
  const runner = read('src/main/libs/coworkRunner.ts');
  assert.match(runner, /text: projectorHeld \? buildProjectorWelcomeHoldPrompt\(\) : buildProjectorModePrompt\(\)/);
  assert.equal((runner.match(/this\.isProjectorHeldByStage\?\.\(sessionId\) === true/g) ?? []).length, 2, 'both prompt compose paths pass the hold');
  const prompts = read('src/main/libs/assistantModePrompt.ts');
  const hold = prompts.slice(prompts.indexOf('export function buildProjectorWelcomeHoldPrompt'));
  assert.match(hold, /不要调用 projection_begin/);
  assert.match(hold, /优先于「首轮必须投影」/);
  assert.match(hold, /Do not call projection_begin/);
  assert.match(hold, /overrides the first-turn projection rule/);
});

test('the Genesis package ships with the app and has its own test script', () => {
  assert.match(read('electron-builder.json'), /"dist\/\*\*\/\*"/);
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts['test:studio-genesis-stage'], /studioGenesisStageService\.test\.mjs/);
  assert.match(read('public/live-stage/liquid-orb-LICENSE.txt'), /Copyright \(c\) 2026 LerSent001/);
});
