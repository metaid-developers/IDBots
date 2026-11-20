import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import test from 'node:test';

const require = Module.createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPreferredSystemLanguages: () => ['en-US'] } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const {
  buildMobileModePrompt,
  buildMobileTwinOrchestrationPrompt,
  buildMobileTwinProductPrimerSection,
  buildMobileWelcomeGuidePrompt,
} = require('../src/main/libs/mobileModePrompt.ts') as typeof import('../src/main/libs/mobileModePrompt.ts');
Module._load = originalLoad;

const runnerSource = readFileSync(new URL('../src/main/libs/coworkRunner.ts', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');

test('mobile personal-agent prompt defines the cloud boundary and a concise mobile tool and delivery policy', () => {
  const prompt = buildMobileModePrompt();
  assert.match(prompt, /IDBots PWA or the IDBots native mobile app/);
  assert.match(prompt, /dedicated IDBots cloud runtime/);
  assert.match(prompt, /scheduled and long-running work can continue while the phone is closed/);
  assert.match(prompt, /NOT running on the phone/);
  assert.match(prompt, /smallest sufficient tool set/);
  assert.match(prompt, /<instant_ack> block is present, the opening is already visible: do not repeat it/);
  assert.match(prompt, /Ordinary web information belongs in web_search \/ web_fetch/);
  assert.match(prompt, /There is only a phone conversation surface/);
  assert.doesNotMatch(prompt, /projection_begin|bot_browser_preview_local|right projector|left chat/);
});

test('mobile product and onboarding knowledge removes desktop workspace teaching', () => {
  const sections = [
    buildMobileTwinProductPrimerSection(),
    buildMobileWelcomeGuidePrompt(),
    buildMobileTwinOrchestrationPrompt(),
  ];
  for (const section of sections) {
    assert.doesNotMatch(section, /Studio|BotWorks|right projector|left chat|local-first desktop app/);
  }
  assert.match(buildMobileWelcomeGuidePrompt(), /personal AI agent app for their phone/);
  assert.match(buildMobileWelcomeGuidePrompt(), /Cloud setup may already have created the owner's Twin Bot/);
  assert.match(buildMobileTwinProductPrimerSection(), /desktop IDBots app is a separate local runtime/);
});

test('mobile mode replaces Studio and projector prompts for both new and continued sessions', () => {
  assert.match(runnerSource, /name: 'idbots:mobile-mode'/);
  assert.match(runnerSource, /text: buildMobileModePrompt\(\)/);
  const desktopOverrides = runnerSource.match(/!mobileOwnerChatMode && this\.isAssistantModeOwnerChatSession\(sessionId\)/g) ?? [];
  assert.equal(desktopOverrides.length, 2);
  assert.match(runnerSource, /if \(this\.isMobileOwnerChatSession\(sessionId\)\) return buildMobileWelcomeGuidePrompt\(\)/);
  assert.match(runnerSource, /if \(this\.isMobileOwnerChatSession\(sessionId\)\) return buildMobileTwinProductPrimerSection\(\)/);
  assert.match(runnerSource, /buildMobileTwinOrchestrationPrompt\(\)/);
  assert.match(runnerSource, /assistantOwnerChatForTurn = this\.isAssistantModeOwnerChatSession\(sessionId\)\s*\|\| this\.isMobileOwnerChatSession\(sessionId\)/);
  assert.match(mainSource, /const greetingPrompt = isServerMode\(\)/);
  assert.match(mainSource, /The user just opened IDBots on mobile for the first time/);
});
