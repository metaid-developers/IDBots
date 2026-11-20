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

test('notification IPC and change event are P1 through CR-WSE-002', () => {
  for (const channel of ['list', 'get', 'getUnreadCount', 'markRead', 'markAllRead']) {
    assert.match(allowlist, new RegExp(`'notification:${channel}': \\{ tier: 'P1'`));
  }
  assert.match(allowlist, /'notification:changed': \{ tier: 'P1'/);
});
