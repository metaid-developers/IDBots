import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import type Database from 'better-sqlite3';
import { FakeDocker } from './fake-docker/index.mjs';
import { freePort, freshDb, seedUserAndTenant, startTestApp, waitFor, type TestApp } from './helpers.js';
import { DockerClient } from '../src/docker/client.js';
import { sha256Hex } from '../src/crypto.js';
import { registerRelease } from '../src/services/releases.js';
import { HostAgentGateway } from '../src/agent/gateway.js';
import { HostAgentClient } from '../src/agent/client.js';
import { RolloutManager } from '../src/rollout/manager.js';
import { SqliteRolloutStore } from '../src/rollout/sqliteStore.js';

const OLD_IMAGE = 'tenant:agent-old';
const NEW_IMAGE = 'tenant:agent-new';
const AGENT_TOKEN = 'test-agent-token';

let db: Database.Database;
let localDocker: FakeDocker;
let remoteDocker: FakeDocker;
let app: TestApp;

before(async () => {
  db = freshDb();
  localDocker = new FakeDocker();
  remoteDocker = new FakeDocker({
    imageEnv: { [NEW_IMAGE]: { FAKE_TENANT_APP_VERSION: '1.2.0' } },
  });
  await localDocker.listen(0);
  await remoteDocker.listen(0);
  app = await startTestApp({ db, dockerUrl: localDocker.url(), tenantImage: OLD_IMAGE });
});

after(async () => {
  await app.close();
  await localDocker.close();
  await remoteDocker.close();
  db.close();
});

async function seedRemoteImage(ref: string): Promise<void> {
  const response = await fetch(`${remoteDocker.url()}/fake/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref, labels: { 'org.idbots.version': '1.2.0', 'org.idbots.rollback-safe-to': '1.0.0' } }),
  });
  assert.equal(response.status, 201);
}

describe('multi-host agent execution', () => {
  test('control plane preflights and upgrades a tenant through the remote host agent', async () => {
    await seedRemoteImage(OLD_IMAGE);
    await seedRemoteImage(NEW_IMAGE);
    db.prepare(`INSERT INTO hosts (id, docker_url, capacity, status, environment, agent_token_hash)
      VALUES ('h_remote', 'agent://h_remote', 58, 'active', 'production', ?)`).run(sha256Hex(AGENT_TOKEN));
    seedUserAndTenant(db, { userId: 'u_remote', phone: '+8613900080000', tenantId: 't_remote', status: 'ready', image: OLD_IMAGE, appVersion: '1.0.0' });
    db.prepare("UPDATE tenants SET host_id = 'h_remote' WHERE id = 't_remote'").run();
    const docker = new DockerClient(remoteDocker.url());
    const created = await docker.createContainer({
      name: 'idb-t_remote',
      image: OLD_IMAGE,
      env: {
        IDBOTS_SERVER_MODE: '1',
        IDBOTS_TENANT_ID: 't_remote',
        IDBOTS_GATEWAY_SECRET: 'test-secret',
        FAKE_TENANT_HEALTH_AFTER_MS: '0',
        FAKE_TENANT_PHASES: 'ready:0',
        FAKE_TENANT_APP_VERSION: '1.0.0',
      },
    });
    await docker.startContainer(created.Id);
    const releaseId = registerRelease(db, {
      schemaVersion: 1,
      sourceSha: 'f'.repeat(40),
      appVersion: '1.2.0',
      contractVersion: '1.0.0',
      rollbackSafeTo: '1.0.0',
      databaseSchemaVersion: 11,
      tenant: { image: NEW_IMAGE, digest: `sha256:${'f'.repeat(64)}` },
      controlPlane: { image: 'cp:agent', digest: `sha256:${'a'.repeat(64)}` },
      createdAt: new Date().toISOString(),
      createdBy: 'test',
    }, 'test').release.id;

    const gateway = new HostAgentGateway(app.app, { requireMtls: false });
    const server = http.createServer();
    gateway.attach(server);
    const port = await freePort();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    app.app.hostAgents = gateway;
    const agent = new HostAgentClient({
      url: `ws://127.0.0.1:${port}/internal/v1/host-agent`,
      hostId: 'h_remote',
      token: AGENT_TOKEN,
      dockerUrl: remoteDocker.url(),
    });
    const manager = new RolloutManager(app.app, new SqliteRolloutStore(db), {
      tickMs: 40,
      leaseMs: 5000,
      readyTimeoutMs: 1500,
      readyPollMs: 40,
    });
    await agent.start();
    try {
      assert.deepEqual(gateway.connectedHostIds(), ['h_remote']);
      const job = await manager.create({ releaseId, operator: 'test', tenantIds: ['t_remote'], soakMs: 0 });
      await manager.start();
      await manager.startJob(job.job.id);
      await waitFor(async () => ((await manager.requireJob(job.job.id)).job.status === 'completed' ? true : null), 15000);
      const tenant = db.prepare('SELECT image, status, app_version FROM tenants WHERE id = ?').get('t_remote') as {
        image: string;
        status: string;
        app_version: string;
      };
      assert.deepEqual(tenant, { image: NEW_IMAGE, status: 'ready', app_version: '1.2.0' });
      const containers = await docker.listContainers({ namePrefix: 'idb-t_remote' });
      assert.equal(containers[0].Image, NEW_IMAGE);
      assert.equal(containers[0].State, 'running');
    } finally {
      await manager.stop();
      await agent.stop();
      await gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
