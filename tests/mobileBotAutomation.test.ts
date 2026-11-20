import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileMockBridge } from '../src/mobile/bridge/mockBridge.ts';
import {
  clampBudget,
  dailyReportUnavailableCopyKey,
  normalizeCreationMode,
} from '../src/mobile/app/automation/botAutomationModel.ts';

test('automation input clamps preserve desktop defaults and reason mapping', () => {
  assert.equal(clampBudget('501', 50, 500), 500);
  assert.equal(clampBudget('-2', 50, 500), 0);
  assert.equal(clampBudget('2.6', 3, 20), 3);
  assert.equal(clampBudget('not-a-number', 8, 23), 8);
  assert.equal(clampBudget('', 50, 500), 50);
  assert.equal(clampBudget(' ', 8, 23), 8);
  assert.equal(normalizeCreationMode('off'), 'off');
  assert.equal(normalizeCreationMode('encouraged'), 'encouraged');
  assert.equal(normalizeCreationMode('invalid'), 'organic');
  assert.equal(dailyReportUnavailableCopyKey('experimental_disabled'), 'mobile.automation.dailyUnavailable.experimental_disabled');
  assert.equal(dailyReportUnavailableCopyKey('unexpected'), 'mobile.automation.dailyUnavailable.unknown');
});

test('mock automation settings persist and the global gate blocks daily reports', async (t) => {
  const bridge = createMobileMockBridge();
  const api = bridge.electron as Window['electron'];
  t.after(() => bridge.destroy());
  assert.equal((await api.metabot.getSetting(1, 'surf_creation_budget')).value, null);
  assert.equal((await api.metabot.setSetting(1, 'surf_creation_budget', '7')).success, true);
  assert.equal((await api.metabot.getSetting(1, 'surf_creation_budget')).value, '7');
  assert.equal((await api.experimentalAutomation.set(false)).success, true);
  assert.equal((await api.experimentalAutomation.get()).enabled, false);
  assert.deepEqual(await api.dailyReport.runNow(), { status: 'unavailable', reason: 'experimental_disabled' });
  await api.metabot.setSetting(1, 'dailyReport.enabled', '1');
  await api.metabot.setSetting(1, 'dailyReport.hour', '9');
  assert.equal((await api.metabot.getSetting(1, 'dailyReport.hour')).value, '9');
  assert.deepEqual(await api.dailyReport.runNow(), { status: 'unavailable', reason: 'experimental_disabled' });
  await api.experimentalAutomation.set(true);
  const result = await api.dailyReport.runNow();
  assert.equal(result.status, 'completed');
  if (result.status === 'completed') {
    const session = await api.cowork.getSession(result.sessionId, { messageLimit: 10 });
    assert.equal(session.success, true);
    assert.match(session.session?.title ?? '', /Daily report/);
  }
});

test('mock Surf transitions from running to a readable report with a live event', async (t) => {
  const bridge = createMobileMockBridge();
  const api = bridge.electron as Window['electron'];
  t.after(() => bridge.destroy());
  const statuses: string[] = [];
  const off = api.surf.onStatusChanged((event) => statuses.push(event.status));
  const result = await api.surf.runNow(1);
  assert.equal(result.success, true);
  assert.equal(result.runId, 'mock-surf-2');
  const running = await api.surf.listRuns(1, 1);
  assert.equal(running.runs?.[0]?.status, 'running');
  await new Promise((resolve) => setTimeout(resolve, 220));
  const completed = await api.surf.listRuns(1, 1);
  assert.equal(completed.runs?.[0]?.status, 'done');
  assert.match(completed.runs?.[0]?.reportMarkdown ?? '', /New Surf report/);
  assert.deepEqual(statuses, ['running', 'done']);
  off();
});
