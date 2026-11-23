import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const scheduler = fs.readFileSync(new URL('../src/main/libs/scheduler.ts', import.meta.url), 'utf8');
const allowlist = fs.readFileSync(new URL('../src/main/gateway/allowlist.ts', import.meta.url), 'utf8');

test('cowork terminal outcomes feed the notification service before the existing stream event', () => {
  assert.ok(main.indexOf("recordCoworkTerminalNotification(sessionId, 'completed')") < main.indexOf("broadcastToRenderers('cowork:stream:complete'"));
  assert.ok(main.indexOf("recordCoworkTerminalNotification(sessionId, 'failed')") < main.indexOf("broadcastToRenderers('cowork:stream:error'"));
});

test('permission creation and resolution both reconcile notification state', () => {
  assert.match(main, /recordPermissionRequired\(\{/);
  assert.match(main, /resolvePermission\(requestId\)/);
});

test('scheduler exposes and invokes a best-effort terminal hook', () => {
  assert.match(scheduler, /onRunTerminal\?:/);
  assert.match(scheduler, /this\.onRunTerminal\?\.\(task, updatedRun\)/);
  assert.match(main, /onRunTerminal: \(task, run\) =>/);
});

test('daily-report and Surf terminal outcomes feed the same notification service', () => {
  assert.match(main, /onResult: \(result\) => \{/);
  assert.match(main, /recordDailyReport\(\{/);
  assert.match(main, /recordSurfRun\(\{/);
  assert.match(main, /payload\.status !== 'running'/);
});

test('long-term task transitions notify only owner-relevant outcomes', () => {
  assert.match(main, /recordLongTermTask\(\{/);
  assert.match(main, /detailForFocus\.stage === 'done'/);
  assert.match(main, /change\.status === 'rejected'/);
});

test('notification IPC and change event are P1 through CR-WSE-002', () => {
  for (const channel of ['list', 'get', 'getUnreadCount', 'markRead', 'markAllRead']) {
    assert.match(allowlist, new RegExp(`'notification:${channel}': \\{ tier: 'P1'`));
  }
  assert.match(allowlist, /'notification:changed': \{ tier: 'P1'/);
});

// --- Completion-state owner push (2026-11-23 root fix) ---------------------
// Four re-verified-green deliveries sat silently in the Studio decision queue
// on 2026-11-22: notification-center rows existed but nothing on desktop
// consumed them, and the queue presented its head only when the conversation
// went idle. These pins keep the active push wired at all three completion
// entry points.

test('the main process wires the completion push to the real desktop Notification API', () => {
  assert.match(main, /getCompletionDesktopNotify = \(\): CompletionDesktopNotify =>/);
  assert.match(main, /createCompletionNotifier\(\{[\s\S]*?Notification\.isSupported\(\)[\s\S]*?new Notification\(\{ title, body \}\)/);
  // Same foreground-suppression policy as the owner-ask notifier.
  assert.match(main, /isWindowForeground: \(\) =>\s*\n\s*Boolean\(mainWindow && !mainWindow\.isDestroyed\(\) && mainWindow\.isVisible\(\) && mainWindow\.isFocused\(\)\)/);
});

test('a newly enqueued decision card pushes once; longterm-linked cards are skipped to avoid double popups', () => {
  assert.match(main, /event\.reason !== 'enqueued'\) return;/);
  assert.match(main, /recordDecisionEnqueued\(\{/);
  assert.match(main, /if \(!item \|\| item\.longtermTaskId\) return;/);
  assert.match(main, /buildDecisionEnqueuedCopy\(item\.title, getPersistedAppLanguage\(\)\)/);
});

test('the waiting_owner subtask transition pushes the desktop notice only on a fresh notification row', () => {
  assert.match(main, /notifyOwnerCompletion\(\s*\{\s*record: \(\) => getNotificationService\(\)\.recordLongTermTask\(\{/);
  assert.match(main, /buildLongTermTaskCopy\(notificationOutcome, notificationTitle, getPersistedAppLanguage\(\)\)/);
});

test('worker attempt terminals wire the owner push through the orchestration service dep', () => {
  assert.match(main, /notifyOwnerCompletion: \(event\) => \{[\s\S]*?recordOrchestrationAttempt\(\{[\s\S]*?attemptId: event\.attemptId/);
  assert.match(main, /buildOrchestrationAttemptCopy\(event, getPersistedAppLanguage\(\)\)/);
});
