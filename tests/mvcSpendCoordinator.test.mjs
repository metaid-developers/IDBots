import test from 'node:test';
import assert from 'node:assert/strict';

const { MvcSpendCoordinator } = await import('../dist-electron/services/mvcSpendCoordinator.js');

test('serializes mvc spend jobs per metabot id', async () => {
  const coordinator = new MvcSpendCoordinator();
  const events = [];

  const first = coordinator.runMvcSpendJob({
    metabotId: 1,
    action: 'first',
    execute: async () => {
      events.push('first:start');
      await new Promise((resolve) => setTimeout(resolve, 25));
      events.push('first:end');
      return 'first-result';
    },
  });

  const second = coordinator.runMvcSpendJob({
    metabotId: 1,
    action: 'second',
    execute: async () => {
      events.push('second:start');
      events.push('second:end');
      return 'second-result';
    },
  });

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult, 'first-result');
  assert.equal(secondResult, 'second-result');
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('allows different metabot ids to execute independently', async () => {
  const coordinator = new MvcSpendCoordinator();
  const events = [];

  await Promise.all([
    coordinator.runMvcSpendJob({
      metabotId: 1,
      action: 'one',
      execute: async () => {
        events.push('one:start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push('one:end');
      },
    }),
    coordinator.runMvcSpendJob({
      metabotId: 2,
      action: 'two',
      execute: async () => {
        events.push('two:start');
        events.push('two:end');
      },
    }),
  ]);

  assert.equal(events.includes('one:start'), true);
  assert.equal(events.includes('two:start'), true);
  assert.equal(events.at(-1), 'one:end');
});

test('releases queue after a failed spend job', async () => {
  const coordinator = new MvcSpendCoordinator();
  const events = [];

  await assert.rejects(() => coordinator.runMvcSpendJob({
    metabotId: 7,
    action: 'failing',
    execute: async () => {
      events.push('failing:start');
      throw new Error('boom');
    },
  }));

  const result = await coordinator.runMvcSpendJob({
    metabotId: 7,
    action: 'recovery',
    execute: async () => {
      events.push('recovery:start');
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  assert.deepEqual(events, ['failing:start', 'recovery:start']);
});
