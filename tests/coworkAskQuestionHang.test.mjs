// Regression coverage for the 2026-09-04 incident: a DSH ask_user_question
// whose prompt never reached a human wedged the cowork session in "running"
// with no log line and no self-healing (session cw-1403e05c-…). The ask path
// had no timeout (approvals got one in waitForPermissionResponse), the hub
// dropped controller-less asks silently, and the question wizard could render
// null while holding the pending-permission queue.
//
// Ownership: ask_user_question waits for a person. The tool is mounted with
// timeout -1, and the kernel patch ignores a model-supplied timeout, so an
// unanswered ask does not become { pending: true } and the host does not
// auto-pick a recommended option. A turn cancel still closes the modal via
// onAskCancelled. The runtime-side check lives in
// dsh-runtime/test/ask-bridge.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

const runnerSource = readSource('src', 'main', 'libs', 'coworkRunner.ts');
const hubSource = readSource('src', 'main', 'libs', 'coworkDshTurn.ts');
const kernelSource = readSource('src', 'main', 'libs', 'dshKernel', 'dshKernel.ts');
const mainSource = readSource('src', 'main', 'main.ts');
const preloadSource = readSource('src', 'main', 'preload.ts');
const coworkServiceSource = readSource('src', 'renderer', 'services', 'cowork.ts');
const generatorSource = readSource('dsh-runtime', 'lib', 'generate-runtime-config.mjs');
const panelSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkPermissionPanel.tsx');
const overlaySource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkPermissionOverlay.tsx');
const sessionDetailSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx');
const appSource = readSource('src', 'renderer', 'App.tsx');
const i18nSource = readSource('src', 'renderer', 'services', 'i18n.ts');

const onAskRequestBody = (() => {
  const start = runnerSource.indexOf('onAskRequest: (ask) => {');
  assert.notEqual(start, -1, 'coworkRunner must register onAskRequest');
  const end = runnerSource.indexOf('onAskCancelled:', start);
  assert.notEqual(end, -1);
  return runnerSource.slice(start, end);
})();

const onAskCancelledBody = (() => {
  const start = runnerSource.indexOf('onAskCancelled: (askId) => {');
  assert.notEqual(start, -1, 'coworkRunner must register onAskCancelled');
  return runnerSource.slice(start, start + 1200);
})();

test('timed ask mode: unanswered questions wait for a person — no host auto-answer', () => {
  // The runtime composition mounts tool-ask-user in timed mode with timeout -1
  // (block until answered). A kernel patch ignores any model-supplied timeout.
  assert.match(generatorSource, /name: '@deepseek-ai\/dsh-tool-ask-user'/);
  assert.match(generatorSource, /config: \{ mode: 'timed', timeout: -1 \}/);
  assert.match(
    readSource('scripts', 'dsh-kernel-patches', '@deepseek-ai+dsh-tool-ask-user+0.2.1-rc.2.patch'),
    /IDBots patch \(ask-waits-for-human\)/,
  );
  // The retired host policy is gone: no 120s constant, no backstop timer, and
  // no recommended-option auto-pick — a timeout must never fabricate an answer
  // the user did not give.
  assert.doesNotMatch(runnerSource, /ASK_PER_QUESTION_TIMEOUT_MS/);
  assert.doesNotMatch(onAskRequestBody, /setTimeout/);
  assert.doesNotMatch(onAskRequestBody, /pickRecommendedOptionLabel/);
  // The renderer wizard never arms its own per-question countdown for DSH asks.
  assert.match(onAskRequestBody, /perQuestionTimeoutMs: null/);
});

test('plan-mode reviews bypass the timed tool schema and stay blocking', () => {
  // dsh-plan-mode asks through ctx.userQuestions.ask() directly (intent
  // 'plan-review'), never through the timed ask_user_question tool definition,
  // so reviews still wait for a human decision or a session cancel.
  assert.match(generatorSource, /dsh-plan-mode calls/);
  assert.match(generatorSource, /plan-review/);
});

test('a cancelled ask (kernel deadline or turn abort) settles the pending entry', () => {
  // The bridge rejects the ask promise and notifies idbots/ask/cancelled when
  // the kernel deadline (or a turn cancel) aborts the wait; the host must
  // delete the pending entry and resolve the modal so nothing strands.
  assert.match(onAskCancelledBody, /this\.pendingPermissions\.delete\(askId\)/);
  assert.match(onAskCancelledBody, /pending\.resolve\(\{ behavior: 'deny'/);
  assert.match(onAskCancelledBody, /activeSession\.pendingPermission = null/);
});

test('the ask handler registers a pending entry and logs a forensics trail', () => {
  assert.match(onAskRequestBody, /this\.pendingPermissions\.set\(ask\.id, \{/);
  assert.match(onAskRequestBody, /ask_user_question awaiting user answer/);
});

test('hub declines asks that have no live turn controller instead of dropping them silently', () => {
  const start = hubSource.indexOf('onAskRequest: (ask) => {');
  assert.notEqual(start, -1, 'dshTurnHub must register onAskRequest');
  const end = hubSource.indexOf('onAskCancelled:', start);
  const body = hubSource.slice(start, end);
  assert.match(body, /no live turn controller for its DSH session; auto-declining/);
  assert.match(body, /kernelOf\(\)\.respondAsk\(/);
  assert.match(body, /The user could not be reached for this question\./);
});

test('hub declines asks when a live controller has no host callback', () => {
  const start = hubSource.indexOf('onAskRequest: (ask) => {');
  const end = hubSource.indexOf('onAskCancelled:', start);
  const body = hubSource.slice(start, end);
  assert.match(body, /const onAskRequest = controller\?\.cb\.onAskRequest/);
  assert.match(body, /!controller \|\| !onAskRequest/);
  assert.match(body, /no host callback for its DSH session; auto-declining/);
  assert.match(body, /kernelOf\(\)\.respondAsk\(/);
});

test('ask bridge assigns ids when the model omits them', () => {
  const pluginSource = readSource('dsh-runtime', 'plugins', 'idbots-sdk-server.mjs');
  assert.match(pluginSource, /rawId.*typeof value\.id === 'string'/);
  assert.match(pluginSource, /`q-\$\{index \+ 1\}`/);
  assert.match(kernelSource, /const rawQuestions = Array\.isArray\(params\.questions\)/);
});

test('composer takeover never renders null while holding the permission queue', () => {
  // A malformed question payload must degrade to an actionable denial card
  // instead of a null render wedging the pending-permission queue.
  assert.doesNotMatch(panelSource, /if \(questions\.length === 0\) \{\s*return null;\s*\}/);
  assert.match(panelSource, /const isMalformedQuestion =/);
  // The deny affordance renders unconditionally, so the queue can always drain.
  assert.match(panelSource, /onClick=\{handleDeny\}/);
  assert.match(panelSource, /behavior: 'deny'/);
});

test('approval owns the active session composer slot instead of a viewport overlay', () => {
  assert.doesNotMatch(panelSource, /fixed\s+inset-x-0\s+bottom-0/);
  assert.match(panelSource, /data-cowork-composer-takeover/);
  assert.match(sessionDetailSource, /pendingPermissions\.find\(\(permission\) => permission\.sessionId === currentSession\.id\)/);
  assert.match(sessionDetailSource, /<CoworkPermissionPanel/);
  assert.match(sessionDetailSource, /A2AFriendApprovalBar/);
  assert.doesNotMatch(appSource, /\{permissionPanel\}/);
  assert.doesNotMatch(overlaySource, /<CoworkPermissionPanel/);
  assert.match(overlaySource, /cowork:viewSession/);
  assert.match(overlaySource, /line-clamp-2/);
});

test('safety approvals use their structured tool context instead of ordinary question controls', () => {
  assert.match(panelSource, /parseSafetyContext/);
  assert.match(panelSource, /context\.requestedToolName/);
  assert.match(panelSource, /context\.requestedToolInput/);
  assert.match(panelSource, /isSafetyApproval/);
  assert.match(panelSource, /coworkApprovalAllowDelete/);
});

test('single-select choices and custom answers stay mutually exclusive', () => {
  assert.match(panelSource, /if \(!question\.multiSelect\) \{[\s\S]*?delete next\[currentStep\]/);
  assert.match(panelSource, /if \(!currentQuestion\.multiSelect && value\.trim\(\)\) \{[\s\S]*?delete next\[currentQuestion\.question\]/);
});

test('multi-step custom answers advance before the final submit', () => {
  // A custom answer on the current question is enough to enable the primary
  // action and move forward. It must not be gated on every later question.
  assert.match(panelSource, /const isCurrentQuestionComplete = Boolean\(currentQuestion && \([\s\S]*?answers\[currentQuestion\.question\]\?\.trim\(\)[\s\S]*?otherInputs\[currentStep\]\?\.trim\(\)[\s\S]*?skippedQuestions\[currentQuestion\.question\] === true[\s\S]*?\)\);/);
  assert.match(panelSource, /const handleNextQuestion = \(\) => \{[\s\S]*?!isCurrentQuestionComplete[\s\S]*?setCurrentStep\(\(step\) => Math\.min\(step \+ 1, totalSteps - 1\)\);[\s\S]*?\};/);
  assert.match(panelSource, /const handleQuestionPrimaryAction = \(\) => \{[\s\S]*?if \(!isLastStep\) \{[\s\S]*?handleNextQuestion\(\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?handleApprove\(\);[\s\S]*?\};/);

  // Only the last step submits, and it still requires every question to be
  // answered or explicitly skipped.
  assert.match(panelSource, /onClick=\{handleQuestionPrimaryAction\}/);
  assert.match(panelSource, /disabled=\{responding \|\| \(isLastStep \? !isQuestionComplete : !isCurrentQuestionComplete\)\}/);
  assert.match(panelSource, /i18nService\.t\(isLastStep \? 'coworkQuestionWizardSubmit' : 'coworkQuestionWizardNext'\)/);

  // Enter mirrors the primary button, while IME composition must not submit.
  assert.match(panelSource, /event\.key !== 'Enter' \|\| event\.nativeEvent\.isComposing/);
  assert.match(panelSource, /event\.preventDefault\(\);[\s\S]*?handleQuestionPrimaryAction\(\);/);
});

test('composer takeover copy exists in both locales', () => {
  for (const key of [
    'coworkQuestionWizardOther',
    'coworkQuestionWizardPrevious',
    'coworkQuestionWizardNext',
    'coworkQuestionSkipThis',
    'coworkApprovalWaiting',
    'coworkApprovalAllowOnce',
    'coworkApprovalAllowDelete',
    'a2aFriendApprovalInviteTitle',
    'a2aFriendApprovalRemoveTitle',
  ]) {
    const occurrences = i18nSource.split(`${key}:`).length - 1;
    assert.ok(occurrences >= 2, `${key} must be defined in both the zh and en locale tables (found ${occurrences})`);
  }
});

// 2026-10-23 incident (session ab67c828, ask-mvkz88jh-2): the wizard walked to
// its 4th question and every control went permanently disabled — options,
// skip, deny and submit — while the model had called ask_user_question with
// timeout:-1, so no kernel deadline would ever unwind the ask. One failed
// respond IPC had latched `responding` with no catch; the modal had no retry
// and no close, and the turn waited forever on a modal nobody could answer.
test('a failed respond never latches the question wizard disabled', () => {
  // Every settle path of handlePermissionResponse resets the responding flag:
  // a rejected/throwing respond IPC re-enables the controls instead of
  // wedging them.
  assert.match(sessionDetailSource, /setIsRespondingToPermission\(true\);/);
  assert.match(
    sessionDetailSource,
    /catch \(error\) \{[\s\S]*?setIsRespondingToPermission\(false\);[\s\S]*?\}/,
  );
  // Settle watchdog: even a never-settling IPC (pathological transport) must
  // not wedge the modal; a retried respond for an already-resolved id is a
  // harmless no-op on the main side.
  assert.match(
    sessionDetailSource,
    /setTimeout\(\(\) => setIsRespondingToPermission\(false\), 15000\)/,
  );
});

test('responding to an unknown requestId still broadcasts resolution', () => {
  // A stale renderer entry must not render an unanswerable modal forever:
  // the unknown-id path broadcasts permissionResolved so the renderer
  // dequeues its copy, and leaves a forensics trail instead of a silent
  // no-op (which made renderer/main drift invisible).
  const start = runnerSource.indexOf('respondToPermission(requestId: string');
  assert.notEqual(start, -1, 'coworkRunner must implement respondToPermission');
  const body = runnerSource.slice(start, start + 2500);
  assert.match(body, /no pending permission for requestId; broadcasting resolved anyway/);
  assert.match(body, /this\.emit\('permissionResolved', '', requestId\)/);
});

test('a reloaded renderer replays still-pending permission requests', () => {
  // The permission broadcast is raise-time only; a window reload while an ask
  // waits (timeout:-1 asks never self-unwind) must re-enqueue the modal from
  // the main-side pending mirror instead of orphaning the turn.
  assert.match(mainSource, /cowork:permission:listPending/);
  assert.match(preloadSource, /listPendingPermissions/);
  assert.match(coworkServiceSource, /listPendingPermissions\?\.\(\)/);
  assert.match(coworkServiceSource, /enqueuePendingPermission\(\{[\s\S]*?perQuestionTimeoutMs: entry\.perQuestionTimeoutMs \?\? null,/);
});
