import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type Database from 'better-sqlite3';
import { freshDb, seedUserAndTenant } from './helpers.js';
import { ensureHostRow } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';
import { selectFleetUpgradeTenantIds } from '../src/services/upgradeSelection.js';

let db: Database.Database;

before(() => {
  db = freshDb();
  ensureHostRow(db, {
    id: 'h_testhost',
    dockerUrl: 'http://docker.test',
    capacity: 27,
    status: 'active',
    environment: 'staging',
  });
});

after(() => {
  db.close();
});

let phoneCounter = 1000;
function seed(id: string, status: string, image: string): void {
  phoneCounter += 1;
  seedUserAndTenant(db, {
    userId: `u_${id}`,
    phone: `+861390000${phoneCounter}`,
    tenantId: id,
    status,
    image,
  });
}

describe('commercial tenant metadata and safe fleet selection', () => {
  test('existing rows receive compatible defaults and host zero capacity is repaired', () => {
    seed('t_meta1', 'ready', 'tenant:new');
    const tenant = db.prepare("SELECT kind, cohort, image_digest FROM tenants WHERE id = 't_meta1'").get() as {
      kind: string;
      cohort: string;
      image_digest: string | null;
    };
    assert.deepEqual(tenant, { kind: 'customer', cohort: 'stable', image_digest: null });
    db.prepare("UPDATE hosts SET capacity = 0 WHERE id = 'h_testhost'").run();
    ensureHostRow(db, {
      id: 'h_testhost',
      dockerUrl: 'http://docker.test',
      capacity: 27,
      status: 'active',
      environment: 'staging',
    });
    const host = db.prepare("SELECT capacity, environment FROM hosts WHERE id = 'h_testhost'").get() as {
      capacity: number;
      environment: string;
    };
    assert.deepEqual(host, { capacity: 27, environment: 'staging' });
  });

  test('fleet selection excludes inactive, duplicate, and same-digest tenants', () => {
    seed('t_sel1', 'ready', 'tenant:old');
    seed('t_sel2', 'degraded', 'tenant:old');
    seed('t_sel3', 'stopped', 'tenant:old');
    seed('t_sel4', 'suspended', 'tenant:old');
    seed('t_sel5', 'failed', 'tenant:old');
    seed('t_sel6', 'ready', 'tenant:new');
    seed('t_sel7', 'ready', 'tenant:alias');
    db.prepare("UPDATE tenants SET image_digest = ? WHERE id = 't_sel7'").run(`sha256:${'a'.repeat(64)}`);
    db.prepare("UPDATE tenants SET kind = 'internal', cohort = 'canary' WHERE id = 't_sel2'").run();

    assert.deepEqual(
      selectFleetUpgradeTenantIds(db, { targetImage: 'tenant:new', targetDigest: `sha256:${'a'.repeat(64)}` }),
      ['t_sel1', 't_sel2'],
    );
    assert.deepEqual(
      selectFleetUpgradeTenantIds(db, {
        targetImage: 'tenant:new',
        kind: 'internal',
        cohort: 'canary',
        environment: 'staging',
      }),
      ['t_sel2'],
    );
    assert.deepEqual(
      selectFleetUpgradeTenantIds(db, { targetImage: 'tenant:new', environment: 'production' }),
      [],
    );
  });

  test('environment and host capacity configuration has safe defaults', () => {
    const env = {
      CP_PUBLIC_ORIGIN: 'https://app.idbots.world',
      CP_DB_PATH: '/tmp/cp.sqlite',
      CP_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      CP_DOCKER_URL: 'http://docker.test',
      CP_TENANT_IMAGE: 'tenant:test',
      CP_TENANT_NETWORK: 'tenants',
      CP_SMS_MODE: 'fake',
      CP_SMS_FAKE_ORIGIN_EXPLICIT: 'true',
      CP_FAKE_SMS_NUMBERS: '+8613900000000',
    };
    assert.equal(loadConfig(env).environment, 'production');
    assert.equal(loadConfig(env).hostCapacity, 58);
    const staging = loadConfig({ ...env, CP_ENVIRONMENT: 'staging', CP_HOST_ID: 'h_staging' });
    assert.equal(staging.environment, 'staging');
    assert.equal(staging.hostCapacity, 27);
    assert.equal(staging.hostId, 'h_staging');
    assert.throws(() => loadConfig({ ...env, CP_ENVIRONMENT: 'test' }), /CP_ENVIRONMENT/);
    assert.throws(() => loadConfig({ ...env, CP_AGENT_LISTEN: '127.0.0.1:9101' }), /CP_AGENT_TLS_CERT_FILE/);
    const operations = loadConfig({
      ...env,
      CP_AGENT_LISTEN: '127.0.0.1:9101',
      CP_AGENT_TLS_CERT_FILE: '/tls/server.crt',
      CP_AGENT_TLS_KEY_FILE: '/tls/server.key',
      CP_AGENT_TLS_CA_FILE: '/tls/ca.crt',
    });
    assert.equal(operations.agent?.listen, '127.0.0.1:9101');
  });
});
