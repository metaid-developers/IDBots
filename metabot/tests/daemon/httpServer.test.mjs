import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createHttpServer } = require('../../dist/daemon/httpServer.js');
const {
  commandSuccess,
  commandManualActionRequired,
  commandFailed,
} = require('../../dist/core/contracts/commandResult.js');

async function startServer() {
  const calls = {
    identity: [],
    services: [],
    trace: [],
    network: [],
  };

  const server = createHttpServer({
    daemon: {
      getStatus: async () => commandSuccess({
        daemonId: 'daemon-local',
        state: 'online',
        lockOwner: 'metabot-daemon',
      }),
      doctor: async () => commandSuccess({
        checks: [
          { code: 'identity_loaded', ok: true },
          { code: 'runtime_lock_held', ok: true },
        ],
      }),
    },
    identity: {
      create: async (input) => {
        calls.identity.push(input);
        return commandSuccess({
          name: input.name,
          globalMetaId: 'gm-local-alice',
          subsidyState: 'claimed',
        });
      },
    },
    network: {
      listServices: async (input) => {
        calls.network.push(input);
        return commandSuccess({
          services: [
            {
              servicePinId: 'service-weather',
              providerGlobalMetaId: 'gm-weather-seller',
              displayName: 'Weather Oracle',
              online: true,
            },
          ],
        });
      },
    },
    services: {
      call: async (input) => {
        calls.services.push(input);
        if (input.request?.servicePinId === 'service-refund') {
          return commandManualActionRequired(
            'manual_refund_required',
            'Seller refund requires manual confirmation.',
            '/ui/refund?orderId=order-1'
          );
        }
        if (input.request?.servicePinId === 'service-missing') {
          return commandFailed('service_offline', 'Remote service is offline.');
        }
        return commandSuccess({
          traceId: 'trace-weather-123',
          externalConversationId: 'metaweb_order:buyer:gm-weather-seller:trace-weather-1',
        });
      },
    },
    trace: {
      getTrace: async (input) => {
        calls.trace.push(input);
        return commandSuccess({
          traceId: input.traceId,
          status: 'completed',
          transcriptPath: '/tmp/trace-weather-123.md',
        });
      },
    },
    ui: {
      renderPage: async (page) => {
        if (page !== 'hub') {
          throw new Error(`Unexpected page ${page}`);
        }
        return `<!doctype html><html><head><title>MetaBot Hub</title></head><body><h1>MetaBot Hub</h1></body></html>`;
      },
    },
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address');
  }

  return {
    calls,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

test('GET /api/daemon/status returns the daemon status envelope', async (t) => {
  const server = await startServer();
  t.after(async () => server.close());

  const response = await fetch(`${server.baseUrl}/api/daemon/status`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, {
    ok: true,
    state: 'success',
    data: {
      daemonId: 'daemon-local',
      state: 'online',
      lockOwner: 'metabot-daemon',
    },
  });
});

test('GET /api/doctor returns the machine-first health envelope', async (t) => {
  const server = await startServer();
  t.after(async () => server.close());

  const response = await fetch(`${server.baseUrl}/api/doctor`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.state, 'success');
  assert.deepEqual(payload.data.checks, [
    { code: 'identity_loaded', ok: true },
    { code: 'runtime_lock_held', ok: true },
  ]);
});

test('POST /api/identity/create parses the JSON body and forwards it to identity.create', async (t) => {
  const server = await startServer();
  t.after(async () => server.close());

  const response = await fetch(`${server.baseUrl}/api/identity/create`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Alice',
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(server.calls.identity, [{ name: 'Alice' }]);
  assert.deepEqual(payload, {
    ok: true,
    state: 'success',
    data: {
      name: 'Alice',
      globalMetaId: 'gm-local-alice',
      subsidyState: 'claimed',
    },
  });
});

test('GET /api/network/services forwards query filters to network.listServices', async (t) => {
  const server = await startServer();
  t.after(async () => server.close());

  const response = await fetch(`${server.baseUrl}/api/network/services?online=true`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(server.calls.network, [{ online: true }]);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.services.length, 1);
  assert.equal(payload.data.services[0].servicePinId, 'service-weather');
});

test('POST /api/services/call returns successful task-level call output', async (t) => {
  const server = await startServer();
  t.after(async () => server.close());

  const request = {
    request: {
      servicePinId: 'service-weather',
      providerGlobalMetaId: 'gm-weather-seller',
      userTask: 'tell me tomorrow weather',
      taskContext: 'Shanghai tomorrow',
    },
  };

  const response = await fetch(`${server.baseUrl}/api/services/call`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(server.calls.services, [request]);
  assert.deepEqual(payload, {
    ok: true,
    state: 'success',
    data: {
      traceId: 'trace-weather-123',
      externalConversationId: 'metaweb_order:buyer:gm-weather-seller:trace-weather-1',
    },
  });
});

test('POST /api/services/publish forwards the JSON payload to services.publish', async (t) => {
  const calls = [];
  const server = createHttpServer({
    services: {
      publish: async (input) => {
        calls.push(input);
        return commandSuccess({
          servicePinId: 'service-weather',
          displayName: 'Weather Oracle',
        });
      },
    },
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address');
  }

  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });

  const request = {
    serviceName: 'weather-oracle',
    displayName: 'Weather Oracle',
    description: 'Weather',
    providerSkill: 'metabot-weather-oracle',
    price: '0.00001',
    currency: 'SPACE',
    outputType: 'text',
  };

  const response = await fetch(`http://127.0.0.1:${address.port}/api/services/publish`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [request]);
  assert.deepEqual(payload, {
    ok: true,
    state: 'success',
    data: {
      servicePinId: 'service-weather',
      displayName: 'Weather Oracle',
    },
  });
});

test('GET /api/trace/:traceId forwards the route parameter to trace.getTrace', async (t) => {
  const server = await startServer();
  t.after(async () => server.close());

  const response = await fetch(`${server.baseUrl}/api/trace/trace-weather-123`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(server.calls.trace, [{ traceId: 'trace-weather-123' }]);
  assert.deepEqual(payload, {
    ok: true,
    state: 'success',
    data: {
      traceId: 'trace-weather-123',
      status: 'completed',
      transcriptPath: '/tmp/trace-weather-123.md',
    },
  });
});

test('GET /ui/hub serves the local HTML hub page', async (t) => {
  const server = await startServer();
  t.after(async () => server.close());

  const response = await fetch(`${server.baseUrl}/ui/hub`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/i);
  assert.match(html, /MetaBot Hub/);
});
