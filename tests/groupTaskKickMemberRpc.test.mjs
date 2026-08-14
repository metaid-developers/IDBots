import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * RPC surface tests for POST /api/idbots/group-task/kick-member (OpenTeam M3).
 * Spins up the real metaidRpcServer with a mocked electron module (same
 * pattern as metaidRpcWalletRoutes.test.mjs). The group-task service layer is
 * intentionally NOT wired here: parameter validation must answer 400 before
 * the service is touched, and a well-formed request fails with 500
 * (service-not-initialized) which proves it reached the service boundary.
 */

function createMetabotStore() {
  return {
    getMetabotById(id) {
      if (id !== 1) return null;
      return { id: 1, name: 'Twin', mvc_address: '1MvcAddress' };
    },
    getMetabotWalletByMetabotId() {
      return null;
    },
    listMetabots() {
      return [{ id: 1, name: 'Twin' }];
    },
  };
}

function resolveCompiledMetaidRpcServerPath() {
  const candidates = [
    '../dist-electron/services/metaidRpcServer.js',
    '../dist-electron/main/services/metaidRpcServer.js',
  ];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      // Try next compile output layout.
    }
  }
  return require.resolve(candidates[0]);
}

function resolveCompiledMetaidRpcEndpointPath() {
  const candidates = [
    '../dist-electron/services/metaidRpcEndpoint.js',
    '../dist-electron/main/services/metaidRpcEndpoint.js',
  ];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      // Try next compile output layout.
    }
  }
  return require.resolve(candidates[0]);
}

const { getMetaidRpcToken } = require(resolveCompiledMetaidRpcEndpointPath());
const RPC_TOKEN = getMetaidRpcToken();
const RPC_AUTH_HEADERS = { 'Content-Type': 'application/json', Authorization: `Bearer ${RPC_TOKEN}` };

async function startRpcServerForTest() {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath() {
            return os.tmpdir();
          },
          getAppPath() {
            return process.cwd();
          },
        },
        BrowserWindow: {
          getAllWindows() {
            return [];
          },
        },
      };
    }
    if (request === './httpListenWithRetry' || request.endsWith('/httpListenWithRetry')) {
      return {
        listenWithRetry(server, _port, host, options = {}) {
          server.listen(0, host, () => {
            if (typeof options.onListening === 'function') options.onListening();
          });
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  let startMetaidRpcServer;
  try {
    const compiledRpcServerPath = resolveCompiledMetaidRpcServerPath();
    delete require.cache[compiledRpcServerPath];
    ({ startMetaidRpcServer } = require(compiledRpcServerPath));
  } finally {
    Module._load = originalLoad;
  }

  const server = startMetaidRpcServer(
    () => createMetabotStore(),
    () => ({
      getDatabase() {
        return {};
      },
      getSaveFunction() {
        return () => {};
      },
    }),
    // Phase 4: memory routes are not exercised here; a stub satisfies the
    // new MemoryBackend getter argument.
    () => ({
      listUserMemories() {
        return [];
      },
      createUserMemory() {
        throw new Error('memory routes are not exercised in this test');
      },
    }),
  );

  await new Promise((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  if (!port) {
    server.close();
    throw new Error('failed to resolve test server port');
  }
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

const postKick = (baseUrl, body) =>
  fetch(`${baseUrl}/api/idbots/group-task/kick-member`, {
    method: 'POST',
    headers: RPC_AUTH_HEADERS,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('rpc group-task kick-member: parameter validation', async () => {
  const { server, baseUrl } = await startRpcServerForTest();
  try {
    // Invalid JSON body.
    {
      const response = await postKick(baseUrl, '{not json');
      const json = await response.json();
      assert.equal(response.status, 400);
      assert.equal(json.success, false);
      assert.match(json.error, /Invalid JSON/);
    }
    // Missing / invalid task_id.
    for (const body of [{}, { task_id: 'x' }, { task_id: -1 }]) {
      const response = await postKick(baseUrl, body);
      const json = await response.json();
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(json.success, false);
      assert.match(json.error, /task_id/);
    }
    // No member identity at all.
    {
      const response = await postKick(baseUrl, { task_id: 1 });
      const json = await response.json();
      assert.equal(response.status, 400);
      assert.match(json.error, /metabot_id, metabot_name or globalmetaid is required/);
    }
    // Invalid metabot_id.
    {
      const response = await postKick(baseUrl, { task_id: 1, metabot_id: 0 });
      const json = await response.json();
      assert.equal(response.status, 400);
      assert.match(json.error, /metabot_id must be a positive integer/);
    }
    // Unknown local bot name.
    {
      const response = await postKick(baseUrl, { task_id: 1, metabot_name: 'Nobody' });
      const json = await response.json();
      assert.equal(response.status, 400);
      assert.match(json.error, /MetaBot not found: Nobody/);
    }
    // Well-formed requests reach the service layer (unwired here → 500).
    for (const body of [
      { task_id: 1, globalmetaid: 'gmid-remote-1', reason: 'spam' },
      { task_id: 1, metabot_id: 1 },
      { task_id: 1, metabot_name: 'Twin' },
    ]) {
      const response = await postKick(baseUrl, body);
      const json = await response.json();
      assert.equal(response.status, 500, JSON.stringify(body));
      assert.equal(json.success, false);
      assert.match(json.error, /groupTaskService not initialized/);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
