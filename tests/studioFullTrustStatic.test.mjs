import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static wiring guard for the Studio full-trust ruling (owner 2026-11-11):
// Studio (browser-type) conversations ALWAYS run bypassPermissions — the
// equivalent of picking 完全信任 on the BotWorks composer chip — but scoped to
// that surface, so the app-level persisted default (the BotWorks chip state)
// is never rewritten by Studio traffic. Behavior is covered by
// coworkTurnSubmission.test.mjs (fake-runner elevation cases); this file pins
// the main-side wiring so a refactor cannot quietly leak the override into
// the global preference or drop the legacy-row elevation.

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const mainSource = read('src/main/main.ts');
const controllerSource = read('src/main/services/coworkTurnSubmission.ts');
const runnerSource = read('src/main/libs/coworkRunner.ts');
const rendererServiceSource = read('src/renderer/services/browserCowork.ts');

test('cowork:session:start forces browser sessions to full trust in the session row and the booted turn', () => {
  // The row records bypassPermissions so displays and restarts agree with the
  // turns that actually ran.
  assert.match(
    mainSource,
    /sessionType === 'browser' \? 'bypassPermissions' : \(options\.permissionMode \?\? 'default'\)/,
  );
  assert.match(
    mainSource,
    /const resolvedPermissionMode = sessionType === 'browser'\s*\n\s*\? 'bypassPermissions'/,
  );
});

test('the persisted global default is never rewritten by Studio session starts', () => {
  // The global-write branch (sync the BotWorks chip with a renderer pick) is
  // guarded against browser sessions — Studio is surface-scoped full trust,
  // not a new global default.
  const globalWriteGuard = mainSource.match(
    /if \(\s*\n\s*sessionType !== 'browser'\s*\n\s*&& options\.permissionMode/,
  );
  assert.ok(globalWriteGuard, 'the setPersistedCoworkPreference branch must exclude browser sessions');
});

test('the submission controller elevates legacy browser rows before the turn boots', () => {
  assert.match(
    controllerSource,
    /if \(currentSession\.sessionType === 'browser' && currentSession\.permissionMode !== 'bypassPermissions'\) \{\s*\n\s*this\.runner\.setPermissionMode\(sessionId, 'bypassPermissions'\);/,
  );
  // The elevation runs ahead of the continueSession call (order matters: the
  // booted turn reads the mode from the row).
  const elevation = controllerSource.indexOf("this.runner.setPermissionMode(sessionId, 'bypassPermissions')");
  const continuation = controllerSource.indexOf('await this.runner.continueSession(sessionId, buildOwnerTurnInputPrompt(text)');
  assert.ok(elevation >= 0 && continuation > elevation, 'elevation must precede continueSession');
  assert.match(controllerSource, /setPermissionMode\(sessionId: string, mode: CoworkPermissionMode\): void;/);
});

test('the runner-level setPermissionMode writes only the session, never the global preference', () => {
  const methodBody = runnerSource.slice(
    runnerSource.indexOf('setPermissionMode(sessionId: string, mode: CoworkPermissionMode): void'),
    runnerSource.indexOf('setSessionGoal(sessionId'),
  );
  assert.match(methodBody, /this\.store\.updateSession\(sessionId, \{ permissionMode: mode \}\)/);
  assert.doesNotMatch(methodBody, /setPersistedCoworkPreference/);
  assert.doesNotMatch(runnerSource, /setPersistedCoworkPreference/);
});

test('the renderer never passes a permissionMode into browser session starts', () => {
  // Passing one through cowork:start would trip the main-side "renderer pick
  // syncs the global default" branch and clobber the BotWorks chip state.
  assert.doesNotMatch(rendererServiceSource, /permissionMode/);
});
