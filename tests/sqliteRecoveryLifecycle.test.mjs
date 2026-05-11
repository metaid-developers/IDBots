import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('SQLiteRecoveryCoordinator stops services and clears old store before closing and reopening', async () => {
  const { SQLiteRecoveryCoordinator } = require('../dist-electron/sqliteRecoveryLifecycle.js');
  const order = [];
  const oldStore = { id: 'old', closed: false };
  const newStore = { id: 'new', closed: false };
  let currentStore = oldStore;

  const coordinator = new SQLiteRecoveryCoordinator({
    getStore: () => currentStore,
    clearStore: () => {
      order.push('clear');
      currentStore = null;
    },
    closeStore: (store) => {
      order.push(`close:${store.id}`);
      store.closed = true;
      assert.equal(currentStore, null);
    },
    resetRuntime: () => order.push('reset'),
    openStore: async () => {
      order.push('open');
      return newStore;
    },
    publishStore: (store) => {
      order.push(`publish:${store.id}`);
      currentStore = store;
    },
    stopServices: async () => {
      order.push('stop');
      assert.equal(currentStore, oldStore);
    },
    startServices: () => {
      order.push('start');
      assert.equal(currentStore, newStore);
    },
    isRecoverableError: () => true,
  });

  await coordinator.recover(new WebAssembly.RuntimeError('memory access out of bounds'), 'privateChatDaemon');

  assert.deepEqual(order, ['stop', 'clear', 'close:old', 'reset', 'open', 'publish:new', 'start']);
  assert.equal(oldStore.closed, true);
  assert.equal(currentStore, newStore);
  assert.equal(coordinator.getState(), 'ready');
});

test('SQLiteRecoveryCoordinator leaves services stopped and store unpublished when reopen fails', async () => {
  const { SQLiteRecoveryCoordinator, SqliteDatabaseUnavailableError } = require('../dist-electron/sqliteRecoveryLifecycle.js');
  const order = [];
  const oldStore = { id: 'old', closed: false };
  let currentStore = oldStore;

  const coordinator = new SQLiteRecoveryCoordinator({
    getStore: () => currentStore,
    clearStore: () => {
      order.push('clear');
      currentStore = null;
    },
    closeStore: (store) => {
      order.push(`close:${store.id}`);
      store.closed = true;
    },
    resetRuntime: () => order.push('reset'),
    openStore: async () => {
      order.push('open');
      throw new WebAssembly.RuntimeError('memory access out of bounds');
    },
    publishStore: () => order.push('publish'),
    stopServices: () => order.push('stop'),
    startServices: () => order.push('start'),
    isRecoverableError: () => true,
  });

  await assert.rejects(
    () => coordinator.recover(new WebAssembly.RuntimeError('memory access out of bounds'), 'privateChatDaemon'),
    /memory access out of bounds/,
  );

  assert.deepEqual(order, ['stop', 'clear', 'close:old', 'reset', 'open']);
  assert.equal(currentStore, null);
  assert.equal(coordinator.getState(), 'failed');

  await assert.rejects(
    () => coordinator.runWithRecovery('metabot:list', async () => 'ok'),
    SqliteDatabaseUnavailableError,
  );
});

test('SQLiteRecoveryCoordinator coalesces concurrent recovery requests', async () => {
  const { SQLiteRecoveryCoordinator } = require('../dist-electron/sqliteRecoveryLifecycle.js');
  let currentStore = { id: 'old' };
  let openStoreResolve;
  let openCount = 0;
  let stopCount = 0;
  let startCount = 0;

  const coordinator = new SQLiteRecoveryCoordinator({
    getStore: () => currentStore,
    clearStore: () => {
      currentStore = null;
    },
    closeStore: () => {},
    resetRuntime: () => {},
    openStore: async () => {
      openCount += 1;
      await new Promise((resolve) => {
        openStoreResolve = resolve;
      });
      return { id: 'new' };
    },
    publishStore: (store) => {
      currentStore = store;
    },
    stopServices: () => {
      stopCount += 1;
    },
    startServices: () => {
      startCount += 1;
    },
    isRecoverableError: () => true,
  });

  const first = coordinator.recover(new WebAssembly.RuntimeError('memory access out of bounds'), 'privateChatDaemon');
  const second = coordinator.recover(new WebAssembly.RuntimeError('memory access out of bounds'), 'cognitiveOrchestrator');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(openCount, 1);
  openStoreResolve();
  await Promise.all([first, second]);

  assert.equal(openCount, 1);
  assert.equal(stopCount, 1);
  assert.equal(startCount, 1);
  assert.equal(coordinator.getState(), 'ready');
});
