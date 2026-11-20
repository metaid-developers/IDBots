// HTTP-level contract for the create-pin caller attribution:
//   POST /api/metaid/create-pin with an optional caller_session_id must
//   cross-check cowork_sessions.metabot_id and hand the resulting origin to
//   createPin; strict mode must refuse a mismatch with 409 BEFORE signing.
//
// The wallet/broadcast layer is stubbed (createPin is replaced on the loaded
// module), so this exercises the real HTTP handler, body parsing, DB lookup,
// decision logic, and response codes without spending fees.
//
// Runs against the compiled output (pnpm run compile:electron first).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { once } from 'node:events';
import { getSqlJs } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);
const TEST_TOKEN = 'rpc-attribution-test-token';

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function openStore(dir) {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  const { SqliteStore } = requireCompiled('../dist-electron/main/sqliteStore.js');
  const store = new SqliteStore(db, path.join(dir, 'test.sqlite'));
  store.initializeTables(dir);
  return store;
}

function requireCompiled(specifier) {
  return require(specifier);
}

function insertSession(db, id, metabotId) {
  const now = Date.now();
  db.run(
    `INSERT INTO cowork_sessions (id, title, status, cwd, metabot_id, created_at, updated_at)
     VALUES (?, ?, 'idle', ?, ?, ?, ?)`,
    [id, `session ${id}`, os.tmpdir(), metabotId, now, now],
  );
}

async function postCreatePin(base, body) {
  const response = await fetch(`${base}/api/metaid/create-pin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('create-pin stamps the caller session verdict into origin and gates mismatch in strict mode', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-rpc-attribution-'));
  const port = await freePort();

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => dir,
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };

  process.env.IDBOTS_RPC_TOKEN = TEST_TOKEN;
  process.env.IDBOTS_METAID_RPC_PORT = String(port);
  delete process.env.IDBOTS_RPC_STRICT_CALLER_SESSION;

  const createPinCalls = [];
  const metaidCore = requireCompiled('../dist-electron/main/services/metaidCore.js');
  metaidCore.createPin = async (store, metabotId, metaidData, options) => {
    createPinCalls.push({ metabotId, metaidData, options });
    return { txids: ['tx-test-1'], pinId: 'tx-test-1i0', totalCost: 1 };
  };

  const store = await openStore(dir);
  insertSession(store.getDatabase(), 'sess-owner', 42);
  insertSession(store.getDatabase(), 'sess-other', 7);

  const { startMetaidRpcServer } = requireCompiled('../dist-electron/main/services/metaidRpcServer.js');
  const server = startMetaidRpcServer(
    () => ({}),
    () => store,
    () => ({}),
  );
  t.after(() => {
    server.close();
    Module._load = originalLoad;
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.IDBOTS_METAID_RPC_PORT;
    delete process.env.IDBOTS_RPC_STRICT_CALLER_SESSION;
  });
  if (!server.listening) {
    await once(server, 'listening');
  }
  const base = `http://127.0.0.1:${port}`;
  const payload = (metabotId, sessionId) => ({
    metabot_id: metabotId,
    metaidData: { operation: 'create', path: '/protocols/simplebuzz', encryption: '0', version: '1.0', contentType: 'text/plain', payload: 'x' },
    ...(sessionId === undefined ? {} : { caller_session_id: sessionId }),
  });

  // 1. No declaration keeps the legacy origin and behavior.
  let result = await postCreatePin(base, payload(42));
  assert.equal(result.status, 200);
  assert.equal(createPinCalls.at(-1).options.origin, 'rpc');

  // 2. Same-owner session → ok.
  result = await postCreatePin(base, payload(42, 'sess-owner'));
  assert.equal(result.status, 200);
  assert.equal(createPinCalls.at(-1).options.origin, 'rpc#s=sess-owner#m=ok');

  // 3. Default mode records a mismatch instead of refusing it.
  result = await postCreatePin(base, payload(42, 'sess-other'));
  assert.equal(result.status, 200);
  assert.equal(createPinCalls.at(-1).options.origin, 'rpc#s=sess-other#m=mismatch');

  // 4. Unknown session → unknown.
  result = await postCreatePin(base, payload(42, 'sess-ghost'));
  assert.equal(result.status, 200);
  assert.equal(createPinCalls.at(-1).options.origin, 'rpc#s=sess-ghost#m=unknown');

  // 5. Strict mode refuses mismatch before signing.
  process.env.IDBOTS_RPC_STRICT_CALLER_SESSION = '1';
  const before = createPinCalls.length;
  result = await postCreatePin(base, payload(42, 'sess-other'));
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'CALLER_SESSION_MISMATCH');
  assert.equal(createPinCalls.length, before, 'mismatch must not reach createPin');

  // 6. Strict mode still admits the rightful owner.
  result = await postCreatePin(base, payload(42, 'sess-owner'));
  assert.equal(result.status, 200);
  assert.equal(createPinCalls.at(-1).options.origin, 'rpc#s=sess-owner#m=ok');
});
