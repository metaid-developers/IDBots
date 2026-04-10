import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createRuntimeStateStore } = require('../../dist/core/state/runtimeStateStore.js');

test('createRuntimeStateStore persists identity, services, and traces in hot runtime state', async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'metabot-runtime-state-'));
  const store = createRuntimeStateStore(homeDir);

  const written = await store.writeState({
    identity: {
      metabotId: 1,
      name: 'Alice',
      createdAt: 1_744_444_444_000,
      path: "m/44'/10001'/0'/0/0",
      publicKey: 'pubkey',
      chatPublicKey: 'chat-pubkey',
      mvcAddress: 'mvc-address',
      btcAddress: 'btc-address',
      dogeAddress: 'doge-address',
      metaId: 'meta-id',
      globalMetaId: 'idq123',
    },
    services: [
      {
        id: 'service-1',
        sourceServicePinId: 'service-1',
        currentPinId: 'service-1',
        creatorMetabotId: 1,
        providerGlobalMetaId: 'idq123',
        providerSkill: 'weather',
        serviceName: 'weather-oracle',
        displayName: 'Weather Oracle',
        description: 'Weather',
        serviceIcon: null,
        price: '0.00001',
        currency: 'MVC',
        skillDocument: '# Weather',
        inputType: 'text',
        outputType: 'text',
        endpoint: 'simplemsg',
        paymentAddress: 'mvc-address',
        payloadJson: '{}',
        available: 1,
        revokedAt: null,
        updatedAt: 1_744_444_444_000,
      },
    ],
    traces: [],
  });

  assert.equal(written.identity.name, 'Alice');
  assert.equal(written.services.length, 1);
  assert.deepEqual(await store.readState(), written);
  assert.match(readFileSync(store.paths.runtimeStatePath, 'utf8'), /Weather Oracle/);
});

test('createRuntimeStateStore keeps daemon state in a dedicated hot file', async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'metabot-daemon-state-'));
  const store = createRuntimeStateStore(homeDir);

  await store.writeDaemon({
    ownerId: 'metabot-daemon-1',
    pid: 12345,
    host: '127.0.0.1',
    port: 4827,
    baseUrl: 'http://127.0.0.1:4827',
    startedAt: 1_744_444_444_000,
  });

  assert.deepEqual(await store.readDaemon(), {
    ownerId: 'metabot-daemon-1',
    pid: 12345,
    host: '127.0.0.1',
    port: 4827,
    baseUrl: 'http://127.0.0.1:4827',
    startedAt: 1_744_444_444_000,
  });

  await store.clearDaemon(12345);
  assert.equal(await store.readDaemon(), null);
});
