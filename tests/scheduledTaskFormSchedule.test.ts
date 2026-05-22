import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScheduleFromFormState,
  parseScheduleToFormState,
} from '../src/renderer/components/scheduledTasks/taskFormSchedule';

test('parses every-N-minutes cron tasks as editable interval schedules', () => {
  const parsed = parseScheduleToFormState({ type: 'cron', expression: '*/10 * * * *' });

  assert.equal(parsed.mode, 'interval');
  assert.equal(parsed.intervalUnit, 'minutes');
  assert.equal(parsed.intervalValue, 10);
  assert.equal(parsed.time, '09:00');

  const updated = buildScheduleFromFormState({
    ...parsed,
    intervalValue: 15,
  });

  assert.deepEqual(updated, {
    type: 'interval',
    intervalMs: 15 * 60 * 1000,
    unit: 'minutes',
    value: 15,
  });
});

test('preserves arbitrary cron expressions in cron edit mode instead of producing NaN time', () => {
  const parsed = parseScheduleToFormState({ type: 'cron', expression: '5 9-17 * * 1-5' });

  assert.equal(parsed.mode, 'cron');
  assert.equal(parsed.cronExpression, '5 9-17 * * 1-5');
  assert.equal(parsed.time, '09:00');

  assert.deepEqual(buildScheduleFromFormState(parsed), {
    type: 'cron',
    expression: '5 9-17 * * 1-5',
  });
});

test('keeps standard daily cron schedules editable as fixed daily times', () => {
  const parsed = parseScheduleToFormState({ type: 'cron', expression: '0 9 * * *' });

  assert.equal(parsed.mode, 'daily');
  assert.equal(parsed.time, '09:00');

  assert.deepEqual(buildScheduleFromFormState(parsed), {
    type: 'cron',
    expression: '0 9 * * *',
  });
});
