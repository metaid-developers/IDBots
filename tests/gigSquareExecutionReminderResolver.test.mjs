import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  resolveGigSquareServiceExecutionReminderFromRows,
} = require('../dist-electron/services/gigSquareExecutionReminderResolver.js');

test('resolveGigSquareServiceExecutionReminderFromRows lets local empty reminder suppress stale remote cache', () => {
  const reminder = resolveGigSquareServiceExecutionReminderFromRows({
    serviceId: 'svc-root',
    serviceName: 'weather-service',
    localRows: [{
      id: 'svc-root',
      pin_id: 'svc-root',
      current_pin_id: 'svc-current',
      source_service_pin_id: 'svc-root',
      service_name: 'weather-service',
      execution_reminder: '',
      payload_json: JSON.stringify({ executionReminder: '' }),
    }],
    remoteRows: [{
      id: 'svc-current',
      pin_id: 'svc-current',
      source_service_pin_id: 'svc-root',
      service_name: 'weather-service',
      execution_reminder: '旧的远端执行提醒',
      content_summary_json: JSON.stringify({ executionReminder: '旧的远端执行提醒' }),
    }],
  });

  assert.equal(reminder, '');
});

test('resolveGigSquareServiceExecutionReminderFromRows uses remote cache only when there is no local match', () => {
  const reminder = resolveGigSquareServiceExecutionReminderFromRows({
    serviceId: 'svc-root',
    serviceName: 'weather-service',
    localRows: [],
    remoteRows: [{
      id: 'svc-current',
      pin_id: 'svc-current',
      source_service_pin_id: 'svc-root',
      service_name: 'weather-service',
      execution_reminder: '如果用户没指定城市就用北京。',
      content_summary_json: JSON.stringify({ executionReminder: '如果用户没指定城市就用北京。' }),
    }],
  });

  assert.equal(reminder, '如果用户没指定城市就用北京。');
});
