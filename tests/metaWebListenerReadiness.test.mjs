import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadMetaWebListenerReadiness() {
  return require('../dist-electron/services/metaWebListenerReadiness.js');
}

test('listener readiness does not restart an existing socket that is still connecting', () => {
  const { planPrivateChatListenerReadiness } = loadMetaWebListenerReadiness();

  const plan = planPrivateChatListenerReadiness({
    localGlobalMetaId: 'idq1localbot',
    config: {
      enabled: true,
      groupChats: false,
      privateChats: true,
      serviceRequests: false,
    },
    hasSocket: true,
    isSocketConnected: false,
  });

  assert.deepEqual(plan, {
    success: true,
    config: {
      enabled: true,
      groupChats: false,
      privateChats: true,
      serviceRequests: false,
    },
    persistConfig: false,
    shouldStartListener: false,
    shouldWaitForConnection: true,
  });
});

test('listener readiness starts the listener when the target socket is missing', () => {
  const { planPrivateChatListenerReadiness } = loadMetaWebListenerReadiness();

  const plan = planPrivateChatListenerReadiness({
    localGlobalMetaId: 'idq1localbot',
    config: {
      enabled: true,
      groupChats: false,
      privateChats: true,
      serviceRequests: false,
    },
    hasSocket: false,
    isSocketConnected: false,
  });

  assert.equal(plan.shouldStartListener, true);
  assert.equal(plan.shouldWaitForConnection, true);
});
