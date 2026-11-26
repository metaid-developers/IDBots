import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { FakeDocker } from './fake-docker/index.mjs';
import {
  DEFAULT_DOCKER_MUTATION_TIMEOUT_MS,
  DEFAULT_DOCKER_REQUEST_TIMEOUT_MS,
  DockerClient,
  DockerError,
  tenantBaseUrl,
} from '../src/docker/client.js';

interface FakeContainerRecord {
  id: string;
  name: string;
  state: string;
  exitCode: number | null;
}

let fake: FakeDocker;
let client: DockerClient;
let baseUrl: string;

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== null && value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

before(async () => {
  fake = new FakeDocker();
  const port = await fake.listen(0);
  baseUrl = `http://127.0.0.1:${port}`;
  client = new DockerClient(baseUrl);
});

after(async () => {
  await fake.close();
});

describe('docker client against the fake engine', () => {
  test('ping answers true', async () => {
    assert.equal(await client.ping(), true);
  });

  test('ping answers false when nothing listens', async () => {
    const dead = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
      server.on('error', reject);
    });
    const unreachable = new DockerClient(`http://127.0.0.1:${dead}`);
    assert.equal(await unreachable.ping(), false);
  });

  test('a POST with a body declares Content-Type application/json (socket-proxy contract)', async () => {
    // The staging docker-socket-proxy rejects bodied requests that are not
    // application/json with 400, and FakeDocker now enforces the same
    // contract, so the create succeeding here is itself the behavioral
    // assertion; the recorded header pins the exact wire value.
    await client.createVolume('idb-t_ct', { 'org.idbots.kind': 'tenant-data' });
    assert.equal(fake.lastBodyContentType, 'application/json');
  });

  test('the fake engine rejects a bodied POST without Content-Type (negative control)', async () => {
    // Raw node:http request with Content-Length but no Content-Type — the
    // exact wire shape the unpatched client produced — must be a 400 at the
    // fake, proving the fake's guard would have caught the defect locally.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/v1.43/volumes/create`,
        { method: 'POST', headers: { 'Content-Length': Buffer.byteLength('{"Name":"negctl"}') } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end('{"Name":"negctl"}');
    });
    assert.equal(status, 400);
  });

  test('volume create + duplicate conflict', async () => {
    const volume = await client.createVolume('idb-t_vol-data', { 'org.idbots.kind': 'tenant-data' });
    assert.equal(volume.Name, 'idb-t_vol-data');
    assert.equal(fake.volumes.has('idb-t_vol-data'), true);
    await assert.rejects(() => client.createVolume('idb-t_vol-data'), (err: unknown) => {
      assert.ok(err instanceof DockerError);
      assert.equal(err.status, 409);
      return true;
    });
  });

  test('image labels via imageInspect; unknown image is a 404', async () => {
    const seedRes = await fetch(`${baseUrl}/fake/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: 'fake-tenant:test',
        labels: { 'org.idbots.version': '0.12.0', 'org.idbots.rollback-safe-to': '0.11.0' },
      }),
    });
    assert.equal(seedRes.status, 201);
    const image = await client.imageInspect('fake-tenant:test');
    assert.equal(image.Config.Labels['org.idbots.version'], '0.12.0');
    assert.equal(image.Config.Labels['org.idbots.rollback-safe-to'], '0.11.0');
    await assert.rejects(() => client.imageInspect('fake-tenant:missing'), (err: unknown) => {
      assert.ok(err instanceof DockerError);
      assert.equal(err.status, 404);
      return true;
    });
  });

  test('full container lifecycle: create/start/inspect/stop/remove', async () => {
    const created = await client.createContainer({
      name: 'idb-t_lc',
      image: 'fake-tenant:test',
      env: {
        IDBOTS_SERVER_MODE: '1',
        IDBOTS_TENANT_ID: 't_lc',
        IDBOTS_GATEWAY_SECRET: 'lc-secret',
        FAKE_TENANT_HEALTH_AFTER_MS: '20',
        FAKE_TENANT_PHASES: 'ready:0',
      },
      labels: { 'org.idbots.version': '0.12.0' },
    });
    assert.ok(created.Id.length > 0);

    await assert.rejects(
      () =>
        client.createContainer({
          name: 'idb-t_lc',
          image: 'fake-tenant:test',
        }),
      (err: unknown) => {
        assert.ok(err instanceof DockerError);
        assert.equal(err.status, 409);
        return true;
      },
    );

    await client.startContainer(created.Id);
    const running = await client.inspectContainer(created.Id);
    assert.equal(running.State.Running, true);
    assert.equal(running.Config.Env.includes('IDBOTS_TENANT_ID=t_lc'), true);
    assert.equal(running.Config.Labels['org.idbots.version'], '0.12.0');

    const binding = running.NetworkSettings.Ports?.['8790/tcp']?.[0];
    assert.ok(binding);
    assert.equal(binding.HostIp, '127.0.0.1');
    assert.ok(Number(binding.HostPort) > 0);

    const url = tenantBaseUrl(running);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await waitFor(async () => {
      const res = await fetch(`${url}/healthz`);
      return res.status === 200 ? res : null;
    });
    assert.equal(health.status, 200);

    const logs = await client.containerLogs(created.Id);
    assert.match(logs, /"msg":"listening"/);

    await client.stopContainer(created.Id, 5);
    const stopped = await client.inspectContainer(created.Id);
    assert.equal(stopped.State.Running, false);
    assert.equal(stopped.State.ExitCode, 0);

    await client.removeContainer(created.Id, { volumes: true });
    assert.equal(fake.containers.has(created.Id), false);
    assert.equal(fake.volumes.has('idb-t_vol-data'), true, 'named volumes survive container removal');
  });

  test('listContainers with a name prefix', async () => {
    const created = await client.createContainer({
      name: 'idb-t_listme',
      image: 'fake-tenant:test',
      env: { IDBOTS_GATEWAY_SECRET: 's', FAKE_TENANT_HEALTH_AFTER_MS: '0' },
    });
    await client.startContainer(created.Id);
    const matched = await client.listContainers({ namePrefix: 'idb-t_listme' });
    assert.equal(matched.length, 1);
    assert.equal(matched[0].Names[0], '/idb-t_listme');
    const missed = await client.listContainers({ namePrefix: 'zzz-no-match' });
    assert.equal(missed.length, 0);
  });

  test('a crashing child leaves the container exited with its code', async () => {
    const created = await client.createContainer({
      name: 'idb-t_crash',
      image: 'fake-tenant:test',
      env: {
        IDBOTS_GATEWAY_SECRET: 's',
        FAKE_TENANT_HEALTH_AFTER_MS: '0',
        FAKE_TENANT_EXIT_AFTER_MS: '60',
      },
    });
    await client.startContainer(created.Id);
    const record = fake.containers.get(created.Id) as unknown as FakeContainerRecord;
    assert.equal(record.state, 'running');
    const exited = await waitFor(async () => {
      const inspect = await client.inspectContainer(created.Id);
      return inspect.State.Running ? null : inspect;
    }, 10_000);
    assert.equal(exited.State.ExitCode, 1);
  });

  test('container mutations use a longer timeout budget than regular Docker reads', async () => {
    assert.equal(DEFAULT_DOCKER_REQUEST_TIMEOUT_MS, 10_000);
    assert.equal(DEFAULT_DOCKER_MUTATION_TIMEOUT_MS, 60_000);

    // Local stub server that delays every response by 150 ms so we can verify
    // createContainer/startContainer/stopContainer/removeContainer use mutationTimeoutMs
    // while inspectContainer uses requestTimeoutMs.
    const slowServer = http.createServer((req, res) => {
      req.resume();
      setTimeout(() => {
        if (req.url?.includes('/containers/create')) {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ Id: 'slow-1' }));
          return;
        }
        if (req.url?.endsWith('/start') || req.url?.includes('/stop')) {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Id: 'slow-1' }));
      }, 150);
    });
    await new Promise<void>((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
    const addr = slowServer.address() as net.AddressInfo;
    try {
      const slowClient = new DockerClient(`http://127.0.0.1:${addr.port}`, {
        requestTimeoutMs: 50,
        mutationTimeoutMs: 500,
      });
      await assert.rejects(() => slowClient.inspectContainer('slow-1'), /timed out/);
      const created = await slowClient.createContainer({ name: 'idb-slow', image: 'fake-tenant:test' });
      assert.equal(created.Id, 'slow-1');
      await slowClient.startContainer('slow-1');
      await slowClient.stopContainer('slow-1', 1);
      await slowClient.removeContainer('slow-1');
    } finally {
      await new Promise<void>((resolve) => slowServer.close(() => resolve()));
    }
  });
});

describe('tenantBaseUrl', () => {
  test('uses the host port mapping when present (local fake path)', () => {
    const url = tenantBaseUrl({
      Id: 'x',
      NetworkSettings: {
        Networks: { bridge: { IPAddress: '' } },
        Ports: { '8790/tcp': [{ HostIp: '127.0.0.1', HostPort: '51234' }] },
      },
    } as never);
    assert.equal(url, 'http://127.0.0.1:51234');
  });

  test('falls back to the container IP at the gateway port (production path)', () => {
    const url = tenantBaseUrl({
      Id: 'x',
      NetworkSettings: {
        Networks: { 'idbots-tenants': { IPAddress: '172.18.0.7' } },
        Ports: null,
      },
    } as never);
    assert.equal(url, 'http://172.18.0.7:8790');
  });

  test('throws when the container has no usable address', () => {
    assert.throws(() =>
      tenantBaseUrl({
        Id: 'x',
        NetworkSettings: { Networks: { bridge: { IPAddress: '' } }, Ports: null },
      } as never),
    );
  });
});
