import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type Database from 'better-sqlite3';
import { freshDb } from './helpers.js';
import { buildContainerSpec, TENANT_SWAP_MULTIPLIER } from '../src/services/provisioning.js';

// C1 "Resources": a tenant is capped at 2304 MB of RAM and may use as much
// host swap again (CR-WSA-006). Provisioning and the upgrade-time recreation
// both go through buildContainerSpec, so this is the one place to pin it.

const MIB = 1024 * 1024;

let db: Database.Database;

before(() => {
  db = freshDb();
});

after(() => {
  db.close();
});

function specFor(tenantMemoryMb: number) {
  return buildContainerSpec(
    {
      db,
      config: {
        publicOrigin: 'https://app.example.test',
        masterKey: Buffer.alloc(32, 7),
        tenantMemoryMb,
        tenantCpus: 2,
        tenantEnv: {},
        tenantNetwork: 'idbots-tenants',
      },
    } as unknown as Parameters<typeof buildContainerSpec>[0],
    {
      tenantId: 't_resources',
      user: { id: 'u_resources', display_name: 'Resources Test', locale: 'en' },
      image: 'registry.example.com/idbots/tenant:test',
      gatewaySecret: 'test-secret-test-secret-test-secret',
      includeRedeemCode: false,
    },
  );
}

describe('tenant container resources (C1)', () => {
  test('RAM cap stays at 2304 MB and the swap allowance equals it', () => {
    const hostConfig = specFor(2304).hostConfig;
    assert.equal(hostConfig?.Memory, 2304 * MIB);
    assert.equal(TENANT_SWAP_MULTIPLIER, 2);
    assert.equal(hostConfig?.MemorySwap, 2304 * MIB * TENANT_SWAP_MULTIPLIER);
  });

  test('the swap allowance follows a different RAM cap', () => {
    const hostConfig = specFor(1024).hostConfig;
    assert.equal(hostConfig?.Memory, 1024 * MIB);
    assert.equal(hostConfig?.MemorySwap, 2048 * MIB);
  });

  test('the other C1 resource values are untouched next to it', () => {
    const hostConfig = specFor(2304).hostConfig;
    assert.equal(hostConfig?.NanoCpus, 2e9);
    assert.equal(hostConfig?.PidsLimit, 2048);
    assert.equal(hostConfig?.ShmSize, 1024 * MIB);
    assert.deepEqual(hostConfig?.CapDrop, ['ALL']);
    assert.deepEqual(hostConfig?.SecurityOpt, ['no-new-privileges']);
    assert.deepEqual(hostConfig?.RestartPolicy, { Name: 'unless-stopped' });
  });
});
